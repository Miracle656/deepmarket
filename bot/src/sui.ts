// Shared Sui RPC client.
//
// Per-user keypairs live in subs.json via user-wallet.ts. There is no
// global "bot wallet" anymore — every Telegram chat owns its own custodial
// keypair. This module only exposes the read-side RPC client that all
// modules share.

import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import { CONFIG } from './config.js';

let cachedSui: SuiJsonRpcClient | null = null;

export function getSuiClient(): SuiJsonRpcClient {
    if (cachedSui) return cachedSui;
    cachedSui = new SuiJsonRpcClient({
        url: CONFIG.SUI_RPC_URL,
        network: 'testnet',
    });
    return cachedSui;
}
