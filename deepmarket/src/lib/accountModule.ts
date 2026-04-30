

// Fetches the first BalanceManager object owned by the user
export async function getUserBalanceManager(client: any, address: string): Promise<string | null> {
    try {
        const res = await client.getOwnedObjects({
            owner: address,
            options: { showType: true, showContent: true },
        });
        
        const bms = res.data.filter((obj: any) => 
            obj.data?.type?.includes('::balance_manager::BalanceManager')
        );
        
        if (bms.length > 0) {
            return bms[0].data?.objectId || null;
        }
        return null;
    } catch (e) {
        console.error("Failed to query owned objects:", e);
        return null;
    }
}


