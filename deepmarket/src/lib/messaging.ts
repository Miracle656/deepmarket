// DeepMarket per-market chat — Sui Stack Messaging integration.
//
// Stack: @mysten/sui-stack-messaging (beta) + Walrus + Seal + a Rust relayer.
// Reference: github.com/MystenLabs/sui-stack-messaging
//
// This file exposes:
//   - constants (Seal servers, Walrus endpoints, relayer URL, package IDs)
//   - createMessagingClient() factory
//   - market → group UUID registry (localStorage v0; will move to indexer later)

import {
    createSuiStackMessagingClient,
    WalrusHttpStorageAdapter,
} from '@mysten/sui-stack-messaging';
import type { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';

// ──────────────────────────────────────────────────────────────────────────
// Config constants (env-overridable via Vite)
// ──────────────────────────────────────────────────────────────────────────

export const RELAYER_URL =
    (import.meta.env.VITE_RELAYER_URL as string) || 'http://localhost:3001';

const WALRUS_PUBLISHER_URL =
    (import.meta.env.VITE_WALRUS_PUBLISHER_URL as string) ||
    'https://publisher.walrus-testnet.walrus.space';
const WALRUS_AGGREGATOR_URL =
    (import.meta.env.VITE_WALRUS_AGGREGATOR_URL as string) ||
    'https://aggregator.walrus-testnet.walrus.space';
const WALRUS_EPOCHS = Number(import.meta.env.VITE_WALRUS_EPOCHS) || 1;

// Seal key servers (testnet defaults).
function parseSealServerConfigs(): { objectId: string; weight: number }[] {
    const ids = import.meta.env.VITE_SEAL_KEY_SERVER_OBJECT_IDS as string | undefined;
    if (ids) {
        return ids.split(',').map((id) => ({ objectId: id.trim(), weight: 1 }));
    }
    return [
        {
            objectId:
                '0x73d05d62c18d9374e3ea529e8e0ed6161da1a141a94d3f76ae3fe4e99356db75',
            weight: 1,
        },
        {
            objectId:
                '0xf5d14a81a982144ae441cd7d64b09027f116a468bd36e7eca494f750591623c8',
            weight: 1,
        },
    ];
}

// Optional package config override for self-deployed contracts.
function parsePackageConfig() {
    const originalPackageId = import.meta.env
        .VITE_MESSAGING_ORIGINAL_PACKAGE_ID as string | undefined;
    if (!originalPackageId) return undefined;
    return {
        messaging: {
            originalPackageId,
            latestPackageId:
                (import.meta.env.VITE_MESSAGING_LATEST_PACKAGE_ID as string) ||
                originalPackageId,
            namespaceId: (import.meta.env.VITE_MESSAGING_NAMESPACE_ID as string) || '',
            versionId: (import.meta.env.VITE_MESSAGING_VERSION_ID as string) || '',
        },
    };
}

// ──────────────────────────────────────────────────────────────────────────
// Client factory
// ──────────────────────────────────────────────────────────────────────────

export interface CreateClientArgs {
    suiClient: SuiJsonRpcClient;
    address: string;
    onSign: (message: Uint8Array) => Promise<string>;
}

export function createMessagingClient({
    suiClient,
    address,
    onSign,
}: CreateClientArgs) {
    const sealServerConfigs = parseSealServerConfigs();

    const attachments = WALRUS_PUBLISHER_URL && WALRUS_AGGREGATOR_URL
        ? {
              storageAdapter: new WalrusHttpStorageAdapter({
                  publisherUrl: WALRUS_PUBLISHER_URL,
                  aggregatorUrl: WALRUS_AGGREGATOR_URL,
                  epochs: WALRUS_EPOCHS,
                  fetch: (...args: Parameters<typeof fetch>) => fetch(...args),
              }),
              maxFileSizeBytes: 5 * 1024 * 1024,
              maxAttachments: 10,
          }
        : undefined;

    return createSuiStackMessagingClient(suiClient, {
        seal: { serverConfigs: sealServerConfigs },
        encryption: {
            sessionKey: { address, onSign },
        },
        packageConfig: parsePackageConfig(),
        relayer: {
            relayerUrl: RELAYER_URL,
            fetch: (...args: Parameters<typeof fetch>) => fetch(...args),
        },
        attachments,
    });
}

// ──────────────────────────────────────────────────────────────────────────
// Deterministic UUID derivation from market objectId
// ──────────────────────────────────────────────────────────────────────────
//
// Each market's chat group uses a UUID derived from the market's objectId.
// This means any wallet visiting a market computes the same UUID without
// needing a registry — the chat is self-discoverable from the market alone.
//
// Format: RFC 4122 v8 (custom-namespace) UUID, deterministic on input.

/**
 * FNV-1a 32-bit hash. Sync, deterministic, well-distributed.
 * Used to avalanche short inputs (like numeric market IDs) into a wide range.
 */
function fnv1a32(input: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < input.length; i++) {
        h ^= input.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
}

/** Compose a 128-bit hex string from input by salting four FNV passes. */
function hash128Hex(input: string): string {
    const parts = [0, 1, 2, 3].map((salt) =>
        fnv1a32(`${input}|${salt}`).toString(16).padStart(8, '0')
    );
    return parts.join('');
}

/**
 * Deterministically derive a UUID for a market's chat group.
 *
 * Combines a deployment-unique salt (registry ID if available) with the
 * market's identifier, hashes to 128 bits, then formats as RFC 4122 v8 UUID.
 * Same market always produces the same UUID; different markets never collide.
 */
export function marketUuidFor(marketObjectId: string): string {
    const registry =
        (import.meta.env.VITE_MARKET_REGISTRY as string) || 'deepmarket';
    const seed = `${registry}#${marketObjectId}`;
    const hex = hash128Hex(seed); // 32 hex chars

    // Set version (8 = custom v8) and variant (10xx) bits per RFC 4122.
    //   UUID layout: xxxxxxxx-xxxx-Mxxx-Nxxx-xxxxxxxxxxxx
    //     position 12 → version digit = '8'
    //     position 16 → variant digit = '8' / '9' / 'a' / 'b'
    const u =
        hex.slice(0, 12) +
        '8' +
        hex.slice(13, 16) +
        'a' +
        hex.slice(17, 32);

    return [
        u.slice(0, 8),
        u.slice(8, 12),
        u.slice(12, 16),
        u.slice(16, 20),
        u.slice(20, 32),
    ].join('-');
}
