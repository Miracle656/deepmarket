// Settled-Redeem Keeper (idea bank #8).
//
// A public-good keeper: it scans EVERY PredictManager for settled, un-redeemed
// winning positions and calls `predict::redeem_permissionless` so owners get
// their payout even if they never come back to claim. The keeper pays gas; the
// payout is deposited into the OWNER's manager (the deployed contract routes
// `redeem_permissionless` to the owner via `deposit_permissionless` — there is
// NO on-chain keeper tip, so this is run as a public good, not for profit).
//
// Everything here is real on-chain action — no mocks, no simulation. Run with:
//   KEEPER_PRIVATE_KEY=suiprivkey... npm run keeper          (loop)
//   KEEPER_PRIVATE_KEY=suiprivkey... npm run keeper -- --once (single pass)
//
// The keeper address must hold a little testnet SUI for gas.

import { Transaction } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { fromHex } from '@mysten/sui/utils';
import { CONFIG } from './config.js';
import { getSuiClient } from './sui.js';
import { listAllManagers, getManagerPositions, type Position } from './predict.js';

const PKG = CONFIG.PREDICT_PACKAGE_ID;
const PREDICT_OBJECT = CONFIG.PREDICT_OBJECT_ID;
const DUSDC = CONFIG.PREDICT_DUSDC_TYPE;
const INTERVAL_MS = Number(process.env.KEEPER_INTERVAL_MS ?? 5 * 60 * 1000);

function keeperKeypair(): Ed25519Keypair {
    const sk = (process.env.KEEPER_PRIVATE_KEY ?? '').trim();
    if (!sk) {
        throw new Error('KEEPER_PRIVATE_KEY is not set (expect suiprivkey… or hex)');
    }
    if (sk.startsWith('suiprivkey')) return Ed25519Keypair.fromSecretKey(sk);
    return Ed25519Keypair.fromSecretKey(fromHex(sk.startsWith('0x') ? sk.slice(2) : sk));
}

/** A binary `redeem_permissionless` PTB for one settled, claimable position. */
function buildRedeemPermissionlessTx(p: {
    managerId: string;
    oracleId: string;
    expiry: number;
    strike: number;
    isUp: boolean;
    quantity: bigint;
}): Transaction {
    const tx = new Transaction();
    const key = tx.moveCall({
        target: `${PKG}::market_key::new`,
        arguments: [
            tx.pure.id(p.oracleId),
            tx.pure.u64(p.expiry),
            tx.pure.u64(p.strike),
            tx.pure.bool(p.isUp),
        ],
    });
    tx.moveCall({
        target: `${PKG}::predict::redeem_permissionless`,
        typeArguments: [DUSDC],
        arguments: [
            tx.object(PREDICT_OBJECT),
            tx.object(p.managerId),
            tx.object(p.oracleId),
            key,
            tx.pure.u64(p.quantity),
            tx.object(CONFIG.CLOCK),
        ],
    });
    return tx;
}

// A settled, un-redeemed WINNING position is worth claiming. Losers pay $0, so
// we skip them (no point burning gas). Status won/redeemable ⇒ oracle settled.
function isClaimable(p: Position): boolean {
    return (p.status === 'won' || p.status === 'redeemable') && p.open_quantity > 0;
}

async function scanOnce(keypair: Ed25519Keypair | null): Promise<void> {
    const dryRun = keypair === null;
    const sui = getSuiClient();
    const keeperAddr = keypair ? keypair.getPublicKey().toSuiAddress() : '(dry-run)';
    const managers = await listAllManagers();
    console.log(`[keeper] scan: ${managers.length} managers · keeper ${keeperAddr}`);

    let claimed = 0;
    let failed = 0;
    const seen = new Set<string>();

    for (const m of managers) {
        const positions = await getManagerPositions(m.manager_id);
        for (const p of positions.filter(isClaimable)) {
            const dedupe = `${m.manager_id}:${p.oracle_id}:${p.strike}:${p.is_up}`;
            if (seen.has(dedupe)) continue;
            seen.add(dedupe);

            if (dryRun) {
                claimed++;
                console.log(
                    `[keeper] (dry-run) would claim $${(p.open_quantity / 1e6).toFixed(2)} ` +
                        `${p.is_up ? 'UP' : 'DOWN'} for ${m.owner.slice(0, 8)}… ` +
                        `(mgr ${m.manager_id.slice(0, 8)}…, oracle ${p.oracle_id.slice(0, 8)}…)`
                );
                continue;
            }

            try {
                const tx = buildRedeemPermissionlessTx({
                    managerId: m.manager_id,
                    oracleId: p.oracle_id,
                    expiry: p.expiry,
                    strike: p.strike,
                    isUp: p.is_up,
                    quantity: BigInt(Math.floor(p.open_quantity)),
                });
                const res = await sui.signAndExecuteTransaction({
                    signer: keypair,
                    transaction: tx,
                    options: { showEffects: true },
                });
                if (res.effects?.status.status === 'success') {
                    claimed++;
                    console.log(
                        `[keeper] ✓ claimed $${(p.open_quantity / 1e6).toFixed(2)} for ` +
                            `${m.owner.slice(0, 8)}… (mgr ${m.manager_id.slice(0, 8)}…) · ${res.digest}`
                    );
                } else {
                    failed++;
                    console.warn(
                        `[keeper] ✗ aborted (mgr ${m.manager_id.slice(0, 8)}…): ${res.effects?.status.error}`
                    );
                }
            } catch (e) {
                failed++;
                console.warn(
                    `[keeper] ✗ error (mgr ${m.manager_id.slice(0, 8)}…):`,
                    e instanceof Error ? e.message : e
                );
            }
        }
    }
    console.log(`[keeper] done — ${claimed} claimed, ${failed} failed`);
}

async function main() {
    const dryRun = process.argv.includes('--dry-run');
    const once = process.argv.includes('--once') || dryRun;
    // Dry-run needs no key (read + report only). Real runs need a funded keeper.
    const keypair = dryRun ? null : keeperKeypair();
    console.log(
        `[keeper] starting — ${dryRun ? 'DRY RUN (no txs)' : once ? 'one-shot' : `loop every ${INTERVAL_MS / 1000}s`}`
    );
    await scanOnce(keypair).catch((e) => console.error('[keeper] scan failed:', e));
    if (once) return;
    setInterval(() => {
        scanOnce(keypair).catch((e) => console.error('[keeper] scan failed:', e));
    }, INTERVAL_MS);
}

main();
