// Fetches the first DeepBook BalanceManager object owned by the user.
//
// Previously this pulled only the first page (~50) of ALL owned objects
// and substring-matched the type. On a wallet that has created several
// markets/pools/token packages the BalanceManager sits past page 1 and
// was never found — so the "Initialize DeepBook" CTA never cleared even
// after the manager was created. We now query by StructType (server-side
// filter, no pagination concern) and fall back to a paginated scan.

// The BalanceManager type is defined by the DeepBook implementation
// package (distinct from the call-package id used for moveCall targets).
const BALANCE_MANAGER_TYPE =
    '0xfb28c4cbc6865bd1c897d26aecbe1f8792d1509a20ffec692c800660cbec6982::balance_manager::BalanceManager';

export async function getUserBalanceManager(
    client: any,
    address: string
): Promise<string | null> {
    // 1. Fast path — server-side type filter, returns only BalanceManagers.
    try {
        const res = await client.getOwnedObjects({
            owner: address,
            filter: { StructType: BALANCE_MANAGER_TYPE },
            options: { showType: true },
        });
        if (res.data?.length > 0) {
            return res.data[0].data?.objectId ?? null;
        }
    } catch (e) {
        console.warn('BalanceManager type-filter query failed, paginating:', e);
    }

    // 2. Fallback — paginate ALL owned objects, substring-match the type
    //    (robust if the implementation package id ever changes).
    try {
        let cursor: string | null | undefined = null;
        do {
            const page: any = await client.getOwnedObjects({
                owner: address,
                cursor,
                options: { showType: true },
            });
            const hit = page.data?.find((obj: any) =>
                obj.data?.type?.includes('::balance_manager::BalanceManager')
            );
            if (hit) return hit.data?.objectId ?? null;
            cursor = page.hasNextPage ? page.nextCursor : null;
        } while (cursor);
        return null;
    } catch (e) {
        console.error('Failed to query owned objects:', e);
        return null;
    }
}
