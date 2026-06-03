// Dry-run of the flow-aware agent's "eyes" — proves the AI perceives live
// platform data, with NO wallet, NO minting, NO Telegram.
//
// It picks the most-traded active oracle, gathers REAL oracle state + order
// flow (the /trades tape) + devInspect-verified quotes, prints the exact prompt
// Claude receives (so you can literally see what the agent sees), then asks
// Claude for a decision and prints it. The decision is never executed.
//
// Run:  cd bot && npx tsx src/dryrun-agent.ts
//       cd bot && npx tsx src/dryrun-agent.ts <oracleId>   (force a specific oracle)
//
// Needs ANTHROPIC_API_KEY in bot/.env to show a live decision; without it the
// prompt (the "eyes") still prints so you can see the perceived data.

import {
    listActiveOracles,
    getOracleState,
    computeOracleFlow,
    spotToUsd,
    type OracleSummary,
} from './predict.js';
import { quoteLadder } from './quote.js';
import {
    decide,
    buildUserPrompt,
    isAgentAvailable,
    type AgentContext,
} from './agent.js';
import { getMemory } from './memory.js';
import { CONFIG } from './config.js';

// devInspect is read-only — any well-formed address works as the sender.
const DEVINSPECT_SENDER =
    '0x0000000000000000000000000000000000000000000000000000000000000001';
const rule = '═'.repeat(72);

async function main() {
    const forced = process.argv[2];

    const oracles = await listActiveOracles();
    if (oracles.length === 0) {
        console.log('No active oracles right now — try again on the next rollover.');
        return;
    }

    // Pick the oracle the agent would actually "see" activity on: most-traded,
    // unless an id was passed explicitly.
    let oracle: OracleSummary = oracles[0]!;
    if (forced) {
        oracle = oracles.find((o) => o.oracle_id === forced) ?? oracles[0]!;
    } else {
        const ranked = await Promise.all(
            oracles.map(
                async (o) =>
                    [o, (await computeOracleFlow(o.oracle_id)).trades] as const
            )
        );
        ranked.sort((a, b) => b[1] - a[1]);
        oracle = ranked[0]![0];
    }

    const state = await getOracleState(oracle.oracle_id);
    const spotRaw = state.latest_price?.spot ?? 0;
    const [flow, quotes, memory] = await Promise.all([
        computeOracleFlow(oracle.oracle_id),
        quoteLadder(DEVINSPECT_SENDER, oracle, spotRaw),
        getMemory(-1), // unused chat id → fresh, empty memory
    ]);

    const ctx: AgentContext = {
        chatId: -1,
        oracle,
        state,
        openPositions: [],
        memory,
        exposureLastHour: 0,
        quotes,
        flow,
    };

    console.log(rule);
    console.log(`Oracle   ${oracle.oracle_id}`);
    console.log(
        `Spot     $${spotToUsd(spotRaw).toFixed(2)}    status=${oracle.status}`
    );
    console.log(
        `Flow     trades=${flow.trades}  netSkew=${flow.netSkew.toFixed(2)}  ` +
            `up=$${flow.upMintUsd.toFixed(2)}  down=$${flow.downMintUsd.toFixed(2)}  ` +
            `redeem=$${flow.redeemUsd.toFixed(2)}  window=${flow.windowMin.toFixed(0)}m`
    );
    console.log(`Quotes   ${quotes.length} devInspect-verified strikes`);
    console.log(rule);

    console.log('\n┌─ WHAT THE AI SEES (exact prompt) ' + '─'.repeat(36));
    console.log(buildUserPrompt(ctx, CONFIG.STRATEGY_QTY_USD));
    console.log('└' + '─'.repeat(70));

    console.log('\n┌─ AI DECISION ' + '─'.repeat(56));
    if (!isAgentAvailable()) {
        console.log(
            'ANTHROPIC_API_KEY not set (or AGENT_ENABLED=false).\n' +
                'The prompt above is exactly what the agent perceives — set the key in\n' +
                'bot/.env to see Claude actually decide on this live data.'
        );
        console.log('└' + '─'.repeat(70));
        return;
    }
    const decision = await decide(ctx, CONFIG.STRATEGY_QTY_USD);
    console.log(JSON.stringify(decision, null, 2));
    console.log('└' + '─'.repeat(70));
    console.log('\n(Dry run — nothing was minted.)');
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
