/* eslint-disable prettier/prettier */
import { percentRegexp } from '../../services/config-manager-v2';
import { BigNumber, ContractInterface, Transaction, Wallet } from 'ethers';
import { OpenoceanConfig } from './openocean.config';
import {
  Token,
  TokenAmount,
  Trade,
  Pair,
  TradeType,
  Route,
  Price,
} from '@uniswap/sdk';
import Decimal from 'decimal.js-light';
import axios from 'axios';
import { logger } from '../../services/logger';
import { Avalanche } from '../../chains/avalanche/avalanche';
import { Ethereum } from '../../chains/ethereum/ethereum';
import { Polygon } from '../../chains/polygon/polygon';
import { Harmony } from '../../chains/harmony/harmony';
import { BinanceSmartChain } from '../../chains/binance-smart-chain/binance-smart-chain';
import { Cronos } from '../../chains/cronos/cronos';
import { Telos } from '../../chains/telos/telos';
import { ExpectedTrade, Uniswapish } from '../../services/common-interfaces';
import {
  HttpException,
  TRADE_FAILED_ERROR_CODE,
//  TRADE_FAILED_ERROR_MESSAGE,
  UniswapishPriceError,
  UNKNOWN_ERROR_ERROR_CODE,
//  UNKNOWN_ERROR_MESSAGE,
} from '../../services/error-handler';
import { getAddress } from 'ethers/lib/utils';

const ODOS_QUOTE_URL = 'https://api.odos.xyz/sor/quote/v2';
//const ODOS_ASSEMBLE_URL = 'https://api.odos.xyz/sor/assemble';

export function newFakeTrade(
  tokenIn: Token,
  tokenOut: Token,
  tokenInAmount: BigNumber,
  tokenOutAmount: BigNumber,
): Trade {
  const baseAmount = new TokenAmount(tokenIn, tokenInAmount.toString());
  const quoteAmount = new TokenAmount(tokenOut, tokenOutAmount.toString());
  // Pair needs the reserves but this is not possible to pull in sushiswap contract
  const pair = new Pair(baseAmount, quoteAmount);
  const route = new Route([pair], tokenIn, tokenOut);
  const trade = new Trade(route, baseAmount, TradeType.EXACT_INPUT);
  // hack to set readonly component given we can't easily get pool token amounts
  (trade.executionPrice as Price) = new Price(
    tokenIn,
    tokenOut,
    tokenInAmount.toBigInt(),
    tokenOutAmount.toBigInt(),
  );
  return trade;
}

export class Openocean implements Uniswapish {
  private static _instances: { [name: string]: Openocean };
  private chainInstance;
  private _chain: string;
  private _network: string;
  private _router: string;
  private _gasLimitEstimate: number;
  private _ttl: number;
  private chainId;
  private tokenList: Record<string, Token> = {};
  private _ready: boolean = false;

  private constructor(chain: string, network: string) {
    this._chain = chain;
    this._network = network;
    const config = OpenoceanConfig.config;
    this.chainInstance = this.getChainInstance(network);
    this.chainId = this.chainInstance.chainId;
    this._router = config.routerAddress(chain, network);
    this._ttl = config.ttl;
    this._gasLimitEstimate = config.gasLimitEstimate;
  }

  public static getInstance(chain: string, network: string): Openocean {
    if (Openocean._instances === undefined) {
      Openocean._instances = {};
    }
    if (!(chain + network in Openocean._instances)) {
      Openocean._instances[chain + network] = new Openocean(chain, network);
    }

    return Openocean._instances[chain + network];
  }

  public getChainInstance(network: string) {
    if (this._chain === 'ethereum') {
      return Ethereum.getInstance(network);
    } else if (this._chain === 'avalanche') {
      return Avalanche.getInstance(network);
    } else if (this._chain === 'polygon') {
      return Polygon.getInstance(network);
    } else if (this._chain === 'harmony') {
      return Harmony.getInstance(network);
    } else if (this._chain === 'binance-smart-chain') {
      return BinanceSmartChain.getInstance(network);
    } else if (this._chain === 'cronos') {
      return Cronos.getInstance(network);
    } else if (this._chain === 'telos') {
      return Telos.getInstance(network);
    } else {
      throw new Error('unsupported chain');
    }
  }

  /**
   * Given a token's address, return the connector's native representation of
   * the token.
   *
   * @param address Token address
   */
  public getTokenByAddress(address: string): Token {
    return this.tokenList[getAddress(address)];
  }

  public async init() {
    if (!this.chainInstance.ready()) {
      await this.chainInstance.init();
    }
    for (const token of this.chainInstance.storedTokenList) {
      this.tokenList[token.address] = new Token(
        this.chainId,
        token.address,
        token.decimals,
        token.symbol,
        token.name,
      );
    }
    this._ready = true;
  }

  public ready(): boolean {
    return this._ready;
  }

  /**
   * Router address.
   */
  public get router(): string {
    return this._router;
  }

  /**
   * Router smart contract ABI.
   */
  public get routerAbi(): ContractInterface {
    return '';
  }

  /**
   * Default gas limit for swap transactions.
   */
  public get gasLimitEstimate(): number {
    return this._gasLimitEstimate;
  }

  /**
   * Default time-to-live for swap transactions, in seconds.
   */
  public get ttl(): number {
    return this._ttl;
  }

  public get chainName(): string {
    if (this._chain === 'ethereum' && this._network === 'mainnet') {
      return 'eth';
    } else if (this._chain === 'ethereum' && this._network === 'arbitrum') {
      return 'arbitrum';
    } else if (this._chain === 'ethereum' && this._network === 'base') {
      return 'base';
    } else if (this._chain === 'ethereum' && this._network === 'optimism') {
      return 'optimism';
    } else if (this._chain === 'avalanche') {
      return 'avax';
    } else if (this._chain === 'binance-smart-chain') {
      return 'bsc';
    }
    // else if (this._chain === 'polygon') {
    //   return 'polygon';
    // } else if (this._chain === 'harmony') {
    //   return 'harmony';
    // } else if (this._chain === 'cronos') {
    //   return 'cronos';
    // }
    return this._chain;
  }

  getSlippageNumberage(): number {
    const allowedSlippage = OpenoceanConfig.config.allowedSlippage;
    const nd = allowedSlippage.match(percentRegexp);
    if (nd) return Number(nd[1]);
    throw new Error(
      'Encountered a malformed percent string in the config for ALLOWED_SLIPPAGE.',
    );
  }

  /**
   * Given the amount of `baseToken` to put into a transaction, calculate the
   * amount of `quoteToken` that can be expected from the transaction.
   *
   * This is typically used for calculating token sell prices.
   *
   * @param baseToken Token input for the transaction
   * @param quoteToken Output from the transaction
   * @param amount Amount of `baseToken` to put into the transaction
   */

  async estimateSellTrade(
    baseToken: Token,
    quoteToken: Token,
    amount: BigNumber,
  ): Promise<ExpectedTrade> {
    logger.info(
      `estimateSellTrade using Odos for baseToken(${baseToken.symbol}): ${baseToken.address} - quoteToken(${quoteToken.symbol}): ${quoteToken.address}.`,
    );
  
    
    const reqAmount = new Decimal(amount.toString())
    .mul(new Decimal(10).pow(baseToken.decimals))
    .toFixed(0); // Convert to string without decimals
    

    //const reqAmount = amount;
  
    try {
      const response = await axios.post(ODOS_QUOTE_URL, {
        chainId: this.chainInstance.chainId,
        inputTokens: [{ tokenAddress: baseToken.address, amount: reqAmount.toString() }],
        outputTokens: [{ tokenAddress: quoteToken.address, proportion: 1.0 }],
        gasPrice: this.chainInstance.gasPrice.toString(),
        slippageLimitPercent: this.getSlippageNumberage(),
      }, {
        headers: {
          "Content-Type": "application/json", // Set the content type
        },
      });
  
      if (response.status === 200) {
        const data = response.data;
        logger.info(`Odos Quote: ${JSON.stringify(data)}`);
  
        if (data.netOutValue > 0) {
          const inAmount = BigNumber.from(data.inAmounts[0]);
          const outAmount = BigNumber.from(data.outAmounts[0]);
  
          const trade = newFakeTrade(baseToken, quoteToken, inAmount, outAmount);
          const maximumOutput = new TokenAmount(quoteToken, outAmount.toString());
          return { trade, expectedAmount: maximumOutput };
        } else {
          logger.error(
            `No valid output from Odos for ${baseToken.address} to ${quoteToken.address}.`,
          );
          throw new UniswapishPriceError(
            `No trade pair found for ${baseToken.address} to ${quoteToken.address}.`,
          );
        }
      } else {
        logger.error(
          `Unexpected response from Odos API: ${response.statusText}`,
        );
        throw new HttpException(
          response.status,
          `Odos API returned unexpected status: ${response.statusText}`,
          TRADE_FAILED_ERROR_CODE,
        );
      }
    } catch (error) {
      if (error instanceof Error) {
        // Handle known Error type
        logger.error(`Error fetching quote from Odos: ${error.message}`);
        throw new HttpException(
          500,
          `Odos API Error: ${error.message}`,
          TRADE_FAILED_ERROR_CODE,
        );
      } else {
        // Handle unknown error type
        logger.error('Unknown error type encountered while fetching quote from Odos.');
        throw new HttpException(
          500,
          'Unknown Odos API Error',
          TRADE_FAILED_ERROR_CODE,
        );
      }
    }
  }

  /**
   * Given the amount of `baseToken` desired to acquire from a transaction,
   * calculate the amount of `quoteToken` needed for the transaction.
   *
   * This is typically used for calculating token buy prices.
   *
   * @param quoteToken Token input for the transaction
   * @param baseToken Token output from the transaction
   * @param amount Amount of `baseToken` desired from the transaction
   */
  async estimateBuyTrade(
    quoteToken: Token,
    baseToken: Token,
    amount: BigNumber,
  ): Promise<ExpectedTrade> {
    logger.info(
      `estimateBuyTrade using Odos for quoteToken(${quoteToken.symbol}): ${quoteToken.address} - baseToken(${baseToken.symbol}): ${baseToken.address}.`,
    );

    logger.info(
      `estimateBuyTrade using Odos for chainId:(${this.chainInstance.chainId})`,
    );

    /*
    const reqAmount = new Decimal(amount.toString())
    .div(new Decimal((10 ** baseToken.decimals).toString()))
    .toString();
    */

    // Convert reqAmount (human-readable) to base units using token decimals
    const reqAmount = new Decimal(amount.toString())
    .mul(new Decimal(10).pow(quoteToken.decimals))
    .toFixed(0); // Convert to string without decimals

    try {

      //azorin: print for debugging
      const payload = {
        chainId: this.chainInstance.chainId,
        inputTokens: [
          {
            tokenAddress: quoteToken.address,
            amount: reqAmount.toString(), // Convert BigNumber to string
          },
        ],
        outputTokens: [
          {
            tokenAddress: baseToken.address,
            proportion: 1.0,
          },
        ],
        gasPrice: this.chainInstance.gasPrice.toString(),
        slippageLimitPercent: this.getSlippageNumberage(),
      };
  
      logger.info(`Payload sent to Odos: ${JSON.stringify(payload)}`);
  
      const response = await axios.post(
        ODOS_QUOTE_URL, // API endpoint
        {
          chainId: this.chainInstance.chainId,
          inputTokens: [
            {
              tokenAddress: quoteToken.address,
              amount: reqAmount.toString(), // Ensure this is in string format
            },
          ],
          outputTokens: [
            {
              tokenAddress: baseToken.address,
              proportion: 1.0,
            },
          ],
          gasPrice: this.chainInstance.gasPrice.toString(),
          slippageLimitPercent: this.getSlippageNumberage(),
        },
        {
          headers: {
            "Content-Type": "application/json", // Set the content type
          },
        },
      );
        
      if (response.status === 200) {
        const data = response.data;
        logger.info(`Odos Quote: ${JSON.stringify(data)}`);
  
        if (data.netOutValue > 0) {
          const inAmount = BigNumber.from(data.inAmounts[0]);
          const outAmount = BigNumber.from(data.outAmounts[0]);
  
          const trade = newFakeTrade(quoteToken, baseToken, inAmount, outAmount);
          const minimumInput = new TokenAmount(quoteToken, inAmount.toString());
          return { trade, expectedAmount: minimumInput };
        } else {
          logger.error(
            `No valid output from Odos for ${quoteToken.address} to ${baseToken.address}.`,
          );
          throw new UniswapishPriceError(
            `No trade pair found for ${quoteToken.address} to ${baseToken.address}.`,
          );
        }
      } else {
        logger.error(
          `Unexpected response from Odos API: ${response.statusText}`,
        );
        throw new HttpException(
          response.status,
          `Odos API returned unexpected status: ${response.statusText}`,
          TRADE_FAILED_ERROR_CODE,
        );
      }
    } catch (error) {
      if (error instanceof Error) {
        logger.error(`Error fetching quote from Odos: ${error.message}`);
        throw new HttpException(
          500,
          `Odos API Error: ${error.message}`,
          TRADE_FAILED_ERROR_CODE,
        );
      } else {
        logger.error('Unknown error type encountered while fetching quote from Odos.');
        throw new HttpException(
          500,
          'Unknown Odos API Error',
          TRADE_FAILED_ERROR_CODE,
        );
      }
    }
  }


  
  /**
   * Given a wallet and a Uniswap-ish trade, try to execute it on blockchain.
   *
   * @param wallet Wallet
   * @param trade Expected trade
   * @param gasPrice Base gas price, for pre-EIP1559 transactions
   * @param openoceanRouter smart contract address
   * @param ttl How long the swap is valid before expiry, in seconds
   * @param abi Router contract ABI
   * @param gasLimit Gas limit
   * @param nonce (Optional) EVM transaction nonce
   * @param maxFeePerGas (Optional) Maximum total fee per gas you want to pay
   * @param maxPriorityFeePerGas (Optional) Maximum tip per gas you want to pay
   */
  async executeTrade(
    wallet: Wallet,
    transaction: any, // Transaction object returned from Odos `/sor/assemble`
  ): Promise<Transaction> {
    try {
      logger.info(`Executing Odos transaction: ${JSON.stringify(transaction)}`);
  
      // Prepare the transaction for execution
      const tx = await wallet.sendTransaction({
        to: transaction.to, // Odos router address
        data: transaction.data, // Call data for executing the trade
        gasLimit: BigNumber.from(transaction.gas), // Suggested gas limit
        gasPrice: BigNumber.from(transaction.gasPrice), // Suggested gas price
        value: BigNumber.from(transaction.value), // ETH input value, if applicable
        chainId: this.chainId, // Chain ID for the transaction
      });
  
      logger.info(`Transaction sent: ${JSON.stringify(tx)}`);
      return tx; // Return the signed and broadcasted transaction
    } catch (error) {
      if (error instanceof Error) {
        logger.error(`Error executing transaction on Odos: ${error.message}`);
        throw new HttpException(
          500,
          `Transaction Execution Error: ${error.message}`,
          UNKNOWN_ERROR_ERROR_CODE,
        );
      } else {
        logger.error('Unknown error type encountered during transaction execution.');
        throw new HttpException(
          500,
          'Unknown Transaction Execution Error',
          UNKNOWN_ERROR_ERROR_CODE,
        );
      }
    }
  }
}
