export async function sentimentGap({ mint, symbol }) {
  return {
    available: false,
    note: 'Belum ditarik — narasi/social belum di-scrape. Jangan menjadikan absennya tweet sebagai sinyal.',
  };
}