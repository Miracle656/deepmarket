// Sui keypair + RPC client for the bot trader.
//
// On first run BOT_SUI_PRIVATE_KEY is empty — we generate a fresh keypair,
// log it to console, and exit telling the operator to paste it into .env.
// This keeps secret-rotation a deliberate human step.

import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import { CONFIG } from './config.js';

let cachedKeypair: Ed25519Keypair | null = null;

export function hasBotTrader(): boolean {
    return CONFIG.BOT_SUI_PRIVATE_KEY.trim().length > 0;
}

/**
 * Generate + log a fresh keypair without persisting it. Used by the setup
 * flow when BOT_SUI_PRIVATE_KEY is empty.
 */
export function generateAndLogFreshKeypair(): { secret: string; address: string } {
    const fresh = new Ed25519Keypair();
    const secret = fresh.getSecretKey();
    const address = fresh.getPublicKey().toSuiAddress();
    console.warn('');
    console.warn('═══════════════════════════════════════════════════════════════');
    console.warn(' BOT_SUI_PRIVATE_KEY is not set. Trader is DISABLED.');
    console.warn(' A fresh keypair has been generated (NOT persisted):');
    console.warn('');
    console.warn(`   BOT_SUI_PRIVATE_KEY=${secret}`);
    console.warn('');
    console.warn(` Bot address: ${address}`);
    console.warn('');
    console.warn(' To enable trading: paste the key into .env, fund the');
    console.warn(' address with SUI + dUSDC, then restart the bot.');
    console.warn('═══════════════════════════════════════════════════════════════');
    return { secret, address };
}

export function getBotKeypair(): Ed25519Keypair {
    if (cachedKeypair) return cachedKeypair;
    const raw = CONFIG.BOT_SUI_PRIVATE_KEY.trim();
    if (!raw) {
        throw new Error(
            'BOT_SUI_PRIVATE_KEY not set — trader is disabled. Set the key in .env to enable.'
        );
    }
    cachedKeypair = Ed25519Keypair.fromSecretKey(raw);
    return cachedKeypair;
}

export function getBotAddress(): string {
    return getBotKeypair().getPublicKey().toSuiAddress();
}

let cachedSui: SuiJsonRpcClient | null = null;

export function getSuiClient(): SuiJsonRpcClient {
    if (cachedSui) return cachedSui;
    cachedSui = new SuiJsonRpcClient({
        url: CONFIG.SUI_RPC_URL,
        network: 'testnet',
    });
    return cachedSui;
}

export async function getSuiBalance(): Promise<bigint> {
    const c = getSuiClient();
    const b = await c.getBalance({
        owner: getBotAddress(),
        coinType: '0x2::sui::SUI',
    });
    return BigInt(b.totalBalance);
}

export async function getDusdcBalance(): Promise<bigint> {
    const c = getSuiClient();
    const b = await c.getBalance({
        owner: getBotAddress(),
        coinType: CONFIG.PREDICT_DUSDC_TYPE,
    });
    return BigInt(b.totalBalance);
}

export function suiToHuman(raw: bigint): number {
    return Number(raw) / 1e9;
}

export function dusdcToHuman(raw: bigint): number {
    return Number(raw) / 10 ** CONFIG.DUSDC_DECIMALS;
}
