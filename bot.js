// ==============================================
//  Teqoin Auto Bridge Bot v4 (Approve + Wrap)
//  Asur Edition | TOR SOCKS5 | Termux Ready
// ==============================================

import { ethers } from 'ethers';
import { SocksProxyAgent } from 'socks-proxy-agent';
import fetch from 'node-fetch';
import fs from 'fs';
import dotenv from 'dotenv';
import { setTimeout } from 'timers/promises';

dotenv.config();

// ============ CONFIG (.env से) ============
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const RPC_URL = process.env.RPC_URL || 'https://rpc.teqoin.io';
const BRIDGE_CONTRACT = '0xbc6ad4965241ea4260eb571c936576a4f537d67b';

// Token addresses + decimals (तेरे sniffed logs से)
const TOKENS = {
    ETH:  { address: '0x0000000000000000000000000000000000000000', decimals: 18 },
    USDT: { address: '0xfcc025A3E170DF62de0e25AF7CeAf1C89aBfe6E9', decimals: 6 },
    USDC: { address: '0xe819EB5be34B20f1FEC012c0DAf960397A0Fb386', decimals: 6 },
    DAI:  { address: '0xB96A869c74Be2eD561D95a77408505371F287d16', decimals: 18 }
};

// Amounts (BN)
const AMOUNTS = {
    ETH:  ethers.parseEther(process.env.BRIDGE_AMOUNT_ETH || '0.01'),
    USDT: ethers.parseUnits(process.env.BRIDGE_AMOUNT_USDT || '10', 6),
    USDC: ethers.parseUnits(process.env.BRIDGE_AMOUNT_USDC || '10', 6),
    DAI:  ethers.parseUnits(process.env.BRIDGE_AMOUNT_DAI || '10', 18)
};

const BRIDGE_ASSETS = (process.env.BRIDGE_ASSETS || 'ETH,USDT,USDC,DAI')
    .split(',').map(a => a.trim().toUpperCase());

const LOOP_MODE = process.env.LOOP_MODE === 'true';
const LOOP_INTERVAL_MIN = parseInt(process.env.LOOP_INTERVAL_MIN || '300') * 1000;
const LOOP_INTERVAL_MAX = parseInt(process.env.LOOP_INTERVAL_MAX || '600') * 1000;
const LOOP_COUNT = parseInt(process.env.LOOP_COUNT || '0'); // 0 = infinite
const MIN_DELAY_MS = parseInt(process.env.MIN_DELAY_MS || '2000');
const MAX_DELAY_MS = parseInt(process.env.MAX_DELAY_MS || '8000');
const TOR_HOST = process.env.TOR_PROXY_HOST || '127.0.0.1';
const TOR_PORT = process.env.TOR_PROXY_PORT || '9050';

// ============ CONSTANTS ============
const ERC20_ABI = [
    'function approve(address spender, uint256 amount) returns (bool)',
    'function allowance(address owner, address spender) view returns (uint256)'
];
const WRAP_METHOD_ID = '0xd6d344a1';

// ============ LOGGING ============
function log(msg, type = 'INFO') {
    const ts = new Date().toISOString();
    const prefix = { INFO: '[•]', OK: '[✓]', ERR: '[✗]', WARN: '[!]', APPROVE: '[💰]' }[type] || '[•]';
    const line = `${prefix} [${ts}] ${msg}`;
    console.log(line);
    try { fs.appendFileSync('bridge_bot.log', line + '\n'); } catch(e) {}
}

// ============ HELPERS ============
function rand(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}
async function randomDelay() {
    const delay = rand(MIN_DELAY_MS, MAX_DELAY_MS);
    log(`Jitter delay: ${delay}ms`, 'INFO');
    await setTimeout(delay);
}

// ============ TOR CHECK ============
async function checkTorConnection() {
    try {
        const agent = new SocksProxyAgent(`socks5h://${TOR_HOST}:${TOR_PORT}`);
        const res = await fetch('https://check.torproject.org/api/ip', { agent, timeout: 15000 });
        const data = await res.json();
        if (data.IsTor) {
            log(`TOR connected | Exit IP: ${data.IP}`, 'OK');
            return true;
        }
        log('TOR proxy responding but NOT routing through TOR network!', 'WARN');
        return false;
    } catch (e) {
        log(`TOR connection FAILED: ${e.message}`, 'ERR');
        return false;
    }
}

// ============ PROVIDER & WALLET ============
function setupProvider() {
    const agent = new SocksProxyAgent(`socks5h://${TOR_HOST}:${TOR_PORT}`);
    const fetchWithProxy = async (url, options = {}) => {
        options.agent = agent;
        return fetch(url, options);
    };
    const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, { fetch: fetchWithProxy });
    const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
    return { provider, wallet };
}

// ============ APPROVE TOKEN ============
async function approveToken(wallet, tokenAddress, tokenSymbol, amount) {
    const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, wallet);

    // Check current allowance
    let currentAllowance;
    try {
        currentAllowance = await tokenContract.allowance(wallet.address, BRIDGE_CONTRACT);
    } catch(e) {
        log(`Allowance check failed: ${e.message}`, 'ERR');
        throw e;
    }

    if (currentAllowance >= amount) {
        log(`${tokenSymbol} already approved: ${ethers.formatUnits(currentAllowance, TOKENS[tokenSymbol].decimals)}`, 'OK');
        return true;
    }

    log(`Approving ${tokenSymbol} | Amount: ${ethers.formatUnits(amount, TOKENS[tokenSymbol].decimals)} | Spender: ${BRIDGE_CONTRACT}`, 'APPROVE');
    await randomDelay();

    try {
        const tx = await tokenContract.approve(BRIDGE_CONTRACT, ethers.MaxUint256);
        log(`Approve tx sent: ${tx.hash}`, 'APPROVE');
        const receipt = await tx.wait();
        log(`${tokenSymbol} approved! Block: ${receipt.blockNumber} | Gas: ${receipt.gasUsed}`, 'OK');
        return true;
    } catch(e) {
        log(`${tokenSymbol} approve FAILED: ${e?.shortMessage || e.message}`, 'ERR');
        throw e;
    }
}

// ============ ENCODE WRAP DATA ============
function encodeWrapData(tokenAddress, receiver, amount) {
    const abiCoder = new ethers.AbiCoder();
    const encodedParams = abiCoder.encode(
        ['address', 'address', 'uint256'],
        [tokenAddress, receiver, amount]
    );
    return WRAP_METHOD_ID + encodedParams.slice(2);
}

// ============ BRIDGE ASSET ============
async function bridgeAsset(wallet, asset, tokenAddress, amount) {
    const decimals = TOKENS[asset].decimals;
    log(`Bridging ${asset} | Amount: ${ethers.formatUnits(amount, decimals)} | Token: ${tokenAddress}`, 'INFO');
    await randomDelay();

    // Token हो तो पहले approve करो
    if (asset !== 'ETH') {
        try {
            await approveToken(wallet, tokenAddress, asset, amount);
        } catch (err) {
            log(`${asset} approval FAILED: ${err?.shortMessage || err.message}`, 'ERR');
            throw err;
        }
    }

    const nonce = await wallet.getNonce('pending');
    const feeData = await wallet.provider.getFeeData();
    const callData = encodeWrapData(tokenAddress, wallet.address, amount);

    log(`Calldata: ${callData.slice(0, 10)}...${callData.slice(-20)}`, 'INFO');

    let gasLimit;
    try {
        const estGas = await wallet.provider.estimateGas({
            from: wallet.address,
            to: BRIDGE_CONTRACT,
            data: callData,
            value: asset === 'ETH' ? amount : 0n
        });
        gasLimit = (estGas * 130n) / 100n; // 30% buffer
        log(`Estimated gas: ${estGas}`, 'INFO');
    } catch (estErr) {
        log(`Gas estimate failed: ${estErr?.shortMessage || estErr.message}, using fallback 400k`, 'WARN');
        gasLimit = 400000n;
    }

    const tx = {
        from: wallet.address,
        to: BRIDGE_CONTRACT,
        data: callData,
        value: asset === 'ETH' ? amount : 0n,
        gasLimit,
        maxFeePerGas: feeData.maxFeePerGas || undefined,
        maxPriorityFeePerGas: feeData.maxPriorityFeePerGas || undefined,
        nonce,
        type: 2
    };

    log(`Sending tx... nonce: ${nonce}`, 'INFO');
    const txResponse = await wallet.sendTransaction(tx);
    log(`Tx sent: ${txResponse.hash}`, 'OK');

    log('Waiting confirmation...', 'INFO');
    const receipt = await txResponse.wait();
    const status = receipt.status === 1 ? 'SUCCESS' : 'FAILED';
    log(`Confirmed! Block: ${receipt.blockNumber} | Gas: ${receipt.gasUsed} | Status: ${status}`,
        receipt.status === 1 ? 'OK' : 'ERR');

    return receipt;
}

// ============ MAIN LOOP ============
async function runBridgeLoop() {
    log('═══ Teqoin Auto Bridge Bot v4 Started ═══', 'INFO');
    log(`Mode: WRAP | Assets: ${BRIDGE_ASSETS.join(', ')} | Loop: ${LOOP_MODE}`, 'INFO');

    if (!(await checkTorConnection())) {
        log('Aborting - TOR connection required', 'ERR');
        process.exit(1);
    }

    const { wallet } = setupProvider();
    log(`Wallet: ${wallet.address}`, 'OK');

    let loopNum = 0;

    do {
        loopNum++;
        log(`═══ Loop #${loopNum} ═══`, 'INFO');

        for (const asset of BRIDGE_ASSETS) {
            try {
                const tokenData = TOKENS[asset];
                const amount = AMOUNTS[asset];
                if (!tokenData || !amount) {
                    log(`Skipping ${asset} - invalid config`, 'WARN');
                    continue;
                }
                await bridgeAsset(wallet, asset, tokenData.address, amount);
            } catch (err) {
                log(`${asset} FAILED: ${err?.shortMessage || err.message}`, 'ERR');
            }
            if (BRIDGE_ASSETS.indexOf(asset) < BRIDGE_ASSETS.length - 1) {
                await randomDelay();
            }
        }

        log(`Loop #${loopNum} completed`, 'OK');

        if (LOOP_MODE && (LOOP_COUNT === 0 || loopNum < LOOP_COUNT)) {
            const wait = rand(LOOP_INTERVAL_MIN, LOOP_INTERVAL_MAX);
            log(`Waiting ${Math.floor(wait / 1000)}s till next loop...`, 'INFO');
            await setTimeout(wait);
        }

    } while (LOOP_MODE && (LOOP_COUNT === 0 || loopNum < LOOP_COUNT));

    log('═══ Bot finished ═══', 'OK');
}

// ============ START ============
if (!PRIVATE_KEY || PRIVATE_KEY === '0x_tumhari_private_key_yahan_daal') {
    log('ERROR: .env में PRIVATE_KEY डालो!', 'ERR');
    process.exit(1);
}

runBridgeLoop().catch(err => {
    log(`FATAL: ${err.message}`, 'ERR');
    console.error(err);
    process.exit(1);
});
