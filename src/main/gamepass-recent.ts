const COLLECTION = '06323672-b8c8-43cc-b0de-32d5a9834749';
const LIMIT = 256 * 1024;
const FAILURE = 'The PC Game Pass recently added list could not be loaded. Try again or choose Default order.';

/** Public PC collection order, never inferred release dates or account rights. */
export function parseRecentPcGames(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 1001) throw Error(FAILURE);
  const metadata = value[0];
  if (!metadata || metadata.siglId !== COLLECTION || !['False', false].includes(metadata.requiresShuffling)) throw Error(FAILURE);
  const ids = value.slice(1).map(row => row?.id);
  if (ids.some(id => typeof id !== 'string' || !/^[A-Z0-9]{12}$/.test(id)) || new Set(ids).size !== ids.length) throw Error(FAILURE);
  return ids;
}

/** Same explicit PC/PC Game Pass contexts as the public Xbox games catalogue. */
export class RecentPcGamePass {
  private cache = new Map<string, {until: number; result: Promise<string[]>}>();
  constructor(private fetcher: typeof fetch = fetch, private now = Date.now) {}
  async get(market: string): Promise<string[]> {
    if (!/^[A-Z]{2}$/.test(market)) throw Error('Invalid PC Game Pass market.');
    let entry = this.cache.get(market);
    if (!entry || entry.until <= this.now()) {
      const current = {until:Infinity,result:Promise.resolve([] as string[])};
      current.result = this.read(market).then(ids => { current.until = this.now() + 10 * 60_000; return ids; }, () => {
        if (this.cache.get(market) === current) this.cache.delete(market);
        throw Error(FAILURE);
      });
      this.cache.set(market,current);entry=current;
      while(this.cache.size>32)this.cache.delete(this.cache.keys().next().value!);
    }
    return [...await entry.result];
  }
  private async read(market: string): Promise<string[]> {
    const url = new URL('https://catalog.gamepass.com/sigls/v3');
    for(const [key,value] of Object.entries({id:COLLECTION,language:'en-US',market,platformContext:'pc',subscriptionContext:'cfq7ttc0kgq8'}))url.searchParams.set(key,value);
    const response = await this.fetcher(url,{headers:{Accept:'application/json'},redirect:'error',signal:AbortSignal.timeout(20_000)});
    if (!response.ok || !response.body || Number(response.headers.get('Content-Length')) > LIMIT) throw Error(FAILURE);
    const reader=response.body.getReader(),parts:Uint8Array[]=[];let bytes=0;
    try{for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.length;if(bytes>LIMIT)throw Error(FAILURE);parts.push(value);}}
    finally{await reader.cancel();}
    return parseRecentPcGames(JSON.parse(Buffer.concat(parts).toString('utf8')));
  }
}
