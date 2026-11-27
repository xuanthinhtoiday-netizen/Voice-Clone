/**
 * Specialized Vietnamese text normalizer for hynt/F5-TTS-Vietnamese-ViVoice (6000h).
 * Prevents attention collapse, dash stumbling, number glitches, and garbled English loanwords.
 */

const DIGITS = ['không', 'một', 'hai', 'ba', 'bốn', 'năm', 'sáu', 'bảy', 'tám', 'chín'];

function readTwoDigits(n: number): string {
  if (n < 10) return DIGITS[n];
  const tens = Math.floor(n / 10);
  const ones = n % 10;
  if (tens === 1) {
    if (ones === 0) return 'mười';
    if (ones === 5) return 'mười lăm';
    return `mười ${DIGITS[ones]}`;
  }
  if (ones === 0) return `${DIGITS[tens]} mươi`;
  if (ones === 1) return `${DIGITS[tens]} mươi mốt`;
  if (ones === 4) return `${DIGITS[tens]} mươi tư`;
  if (ones === 5) return `${DIGITS[tens]} mươi lăm`;
  return `${DIGITS[tens]} mươi ${DIGITS[ones]}`;
}

function readThreeDigits(n: number, fullHundred: boolean): string {
  const hundreds = Math.floor(n / 100);
  const rem = n % 100;
  if (hundreds === 0 && !fullHundred) {
    return readTwoDigits(rem);
  }
  const hPart = `${DIGITS[hundreds]} trăm`;
  if (rem === 0) return hPart;
  if (rem < 10) return `${hPart} lẻ ${DIGITS[rem]}`;
  return `${hPart} ${readTwoDigits(rem)}`;
}

export function integerToVietnamese(num: number): string {
  if (!Number.isFinite(num)) return '';
  if (num < 0) return `âm ${integerToVietnamese(-num)}`;
  const n = Math.floor(num);
  if (n === 0) return 'không';
  if (n < 1000) return readThreeDigits(n, false);

  const units = ['', 'nghìn', 'triệu', 'tỷ'];
  const groups: number[] = [];
  let temp = n;
  while (temp > 0) {
    groups.push(temp % 1000);
    temp = Math.floor(temp / 1000);
  }

  const parts: string[] = [];
  for (let i = groups.length - 1; i >= 0; i--) {
    const g = groups[i];
    if (g === 0) continue;
    const isMostSig = i === groups.length - 1;
    const text = readThreeDigits(g, !isMostSig);
    parts.push(units[i] ? `${text} ${units[i]}` : text);
  }
  return parts.join(' ');
}

/**
 * Common studio / tech English loanwords mapped to Vietnamese-friendly phonetics
 * so F5-TTS-Vietnamese (trained on Vietnamese phonology) pronounces them cleanly.
 */
const LOANWORD_PHONETICS: Array<[RegExp, string]> = [
  [/\bvoxforge\b/gi, 'vốc pho'],
  [/\bvoice\s*cloning\b/gi, 'nhân bản giọng nói'],
  [/\bvoice\s*clone\b/gi, 'giọng nhân bản'],
  [/\bcloned?\b/gi, 'cờ lôn'],
  [/\bf5[\s-]*tts\b/gi, 'ép năm ti ti ét'],
  [/\btts\b/gi, 'ti ti ét'],
  [/\bcloudflare\b/gi, 'cờ lao phờ le'],
  [/\bhono(?:\.js|js)?\b/gi, 'hô nô'],
  [/\bpodcast\b/gi, 'pót cát'],
  [/\bstudio\b/gi, 'sờ tu đi ô'],
  [/\bmastering\b/gi, 'mát tơ ring'],
  [/\baudio\b/gi, 'ao đi ô'],
  [/\bvideo\b/gi, 'vi đê ô'],
  [/\bmicro\b/gi, 'mi cờ rô'],
  [/\bwebsite\b/gi, 'wép sai'],
  [/\bonline\b/gi, 'on lai'],
  [/\boffline\b/gi, 'óp lai'],
  [/\byoutube\b/gi, 'iu túp'],
  [/\btiktok\b/gi, 'tích tóc'],
  [/\bfacebook\b/gi, 'phây búc'],
  [/\breview\b/gi, 'rì viu'],
  [/\bcloud\b/gi, 'cờ lao'],
  [/\bworkers?\b/gi, 'guốc cơ'],
  [/\bscript\b/gi, 'kịch bản'],
  [/\bfile\b/gi, 'phai'],
  [/\bapp\b/gi, 'áp'],
  [/\btool\b/gi, 'tun'],
  [/\btext\b/gi, 'văn bản'],
  [/\bvoice\b/gi, 'giọng nói'],
  [/\bneural\b/gi, 'nơ rần'],
  [/\bworkflow\b/gi, 'quy trình'],
  [/\bserver\b/gi, 'sơ vơ'],
  [/\bbackend\b/gi, 'bách en'],
  [/\bfrontend\b/gi, 'phờ răn en'],
  [/\bgithub\b/gi, 'gít hấp'],
  [/\bai\b/gi, 'ây ai'],
  [/\bgpu\b/gi, 'gi pi iu'],
  [/\bcpu\b/gi, 'xi pi iu'],
  [/\bmp3\b/gi, 'em pi ba'],
  [/\bwav\b/gi, 'wáp'],
  [/\bsrt\b/gi, 'ét a tê'],
  [/\bvtt\b/gi, 'vi ti ti'],
  [/\bkhz\b/gi, 'ki lô héc'],
  [/\bhz\b/gi, 'héc'],
  [/\bms\b/gi, 'mi li giây'],
];

export function normalizeVietnameseForF5(raw: string): string {
  let text = raw.normalize('NFC');

  // Remove bracketed emotion/stage tags that F5-TTS reads literally
  text = text.replace(/\[[^\]]*\]/g, ' ');

  // Replace em-dash / en-dash / slashes / semicolons with natural spoken pauses
  text = text
    .replace(/\s*[—–]\s*/g, ', ')
    .replace(/\s*[:;]\s*/g, ', ')
    .replace(/[""“”«»‘’'`*#_~<>|\\]/g, ' ')
    .replace(/[()\[\]{}]/g, ', ');

  // Ranges like "5-10" or "5 - 10" -> "năm đến mười"
  text = text.replace(/\b(\d{1,6})\s*-\s*(\d{1,6})\b/g, (_, a: string, b: string) => {
    return `${integerToVietnamese(Number(a))} đến ${integerToVietnamese(Number(b))}`;
  });

  // Percentages like "99%" or "100%"
  text = text.replace(/\b(\d{1,6})\s*%/g, (_, a: string) => {
    return `${integerToVietnamese(Number(a))} phần trăm`;
  });

  // Decimal numbers like "1.5" or "48.5"
  text = text.replace(/\b(\d{1,6})[.,](\d{1,2})\b/g, (_, a: string, b: string) => {
    return `${integerToVietnamese(Number(a))} phẩy ${integerToVietnamese(Number(b))}`;
  });

  // Thousand-separated numbers like "100.000" or "1,000,000"
  text = text.replace(/\b(\d{1,3}(?:[.,]\d{3})+)\b/g, (match) => {
    const clean = Number(match.replace(/[.,]/g, ''));
    return Number.isFinite(clean) ? integerToVietnamese(clean) : match;
  });

  // Standalone integers
  text = text.replace(/\b(\d{1,9})\b/g, (_, d: string) => integerToVietnamese(Number(d)));

  // Convert common English tech/studio words to Vietnamese phonetics
  for (const [pattern, replacement] of LOANWORD_PHONETICS) {
    text = text.replace(pattern, replacement);
  }

  // Collapse repeated punctuation & whitespace
  text = text
    .replace(/\s+/g, ' ')
    .replace(/\s*,\s*/g, ', ')
    .replace(/(,\s*){2,}/g, ', ')
    .replace(/\.{2,}/g, '.')
    .replace(/\s*([.!?])\s*/g, '$1 ')
    .replace(/^[,.\s]+/, '')
    .replace(/[,;:\s]+$/, '')
    .trim();

  // Ensure every chunk finishes with clean terminal punctuation so F5-TTS closes prosody cleanly
  if (text && !/[.!?]$/.test(text)) {
    text += '.';
  }

  return text;
}
