import fs from 'fs';
import path from 'path';

const grid = [
  "........................", // Row 0
  ".PPPPPP..........PPPPPP.", // Row 1
  ".PYYYYYP........PYYYYYP.", // Row 2
  "..PYYTTTP......PTTTYYP..", // Row 3
  "...PTTTTTPOOOOPTTTTTP...", // Row 4
  "....PTTTTPOOOOPTTTTP....", // Row 5
  "....PTTTTPOOOOPTTTTP....", // Row 6
  "...PTTTTTPOOOOPTTTTTP...", // Row 7
  "..PYYTTTP......PTTTYYP..", // Row 8
  ".PYYYYYP........PYYYYYP.", // Row 9
  ".PPPPPP..........PPPPPP.", // Row 10
  "........................"  // Row 11
];

const colors = {
  'P': '#a855f7', // Purple
  'Y': '#ffcf24', // Yellow
  'T': '#06b6d4', // Teal
  'O': '#f97316'  // Orange
};

const pixelSize = 6;
const logoX = 20;
const logoY = 24;

let rects = '';
for (let r = 0; r < grid.length; r++) {
  const row = grid[r];
  for (let c = 0; c < row.length; c++) {
    const char = row[c];
    if (char !== '.') {
      const color = colors[char];
      const x = logoX + c * pixelSize;
      const y = logoY + r * pixelSize;
      rects += `  <rect x="${x}" y="${y}" width="${pixelSize}" height="${pixelSize}" fill="${color}" />\n`;
    }
  }
}

function generateSvg(subtitle, metadata) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 680 120" width="680" height="120" fill="none">
  <style>
    .title {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
      font-weight: 800;
      font-size: 38px;
      fill: #0f172a;
    }
    .subtitle {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
      font-style: italic;
      font-size: 16px;
      fill: #475569;
    }
    .metadata {
      font-family: ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, Liberation Mono, monospace;
      font-size: 11px;
      fill: #64748b;
      letter-spacing: 0.5px;
    }
    @media (prefers-color-scheme: dark) {
      .title {
        fill: #ffcf24;
      }
      .subtitle {
        fill: #94a3b8;
      }
      .metadata {
        fill: #64748b;
      }
    }
  </style>
  
  <!-- Pixel Art Bow Tie Logo -->
${rects}
  <!-- Styled Text -->
  <text x="184" y="48" class="title">bow-agent</text>
  <text x="184" y="74" class="subtitle">${subtitle}</text>
  <text x="184" y="96" class="metadata">${metadata}</text>
</svg>
`;
}

const docsDir = path.join(process.cwd(), 'docs', 'media');
fs.mkdirSync(docsDir, { recursive: true });

// Generate English logo
const enSvg = generateSvg(
  'gated writes, shared agent',
  'CLAUDE AGENT SDK · ROLE-BASED MODES · SELF-HOSTED · GATED WORKFLOWS'
);
fs.writeFileSync(path.join(docsDir, 'logo.svg'), enSvg, 'utf-8');
console.log('Generated English logo.svg');

// Generate Vietnamese logo
const viSvg = generateSvg(
  'lập kế hoạch trước, duyệt trước khi ghi',
  'CLAUDE AGENT SDK · CHẾ ĐỘ PHÂN VAI · TỰ HOST · GATED WORKFLOWS'
);
fs.writeFileSync(path.join(docsDir, 'logo.vi.svg'), viSvg, 'utf-8');
console.log('Generated Vietnamese logo.vi.svg');
