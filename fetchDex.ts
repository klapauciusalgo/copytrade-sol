async function fetchDex() {
  const res = await fetch('https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112');
  const data = await res.json();
  console.log(JSON.stringify(data.pairs.slice(0, 3), null, 2));
}
fetchDex();
