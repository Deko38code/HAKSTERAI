// haksterAi ASCII logo — hooded ghost figure + brand text
// Colors use ANSI escape codes: cyberpunk green on black

// Color codes
const C = {
  reset: '\x1b[0m',
  green: '\x1b[38;5;46m',
  greenDim: '\x1b[38;5;28m',
  cyan: '\x1b[38;5;51m',
  white: '\x1b[97m',
  gray: '\x1b[38;5;240m',
  red: '\x1b[38;5;196m',
  yellow: '\x1b[38;5;226m',
  magenta: '\x1b[38;5;201m',
};

function showIntro(version) {
  // Ghost figure lines in green
  const ghostLines = [
    '        ___',
    '      //   \\\\',
    '     || o o ||',
    '     ||  _  ||',
    '      \\\\___//',
    '       |   |',
    '      /     \\\\',
    '     | /| |\\\\ |',
    '     |/ || \\\\||',
    '        ||',
    '        ||',
    '       /||\\\\',
    '      / || \\\\',
  ];

  // Brand text aligned next to ghost
  const brandLines = [
    `  ${C.cyan}HAKSTERAI${C.reset}`,
    `  ${C.gray}─────────${C.reset}`,
    `  ${C.gray}v${version}${C.reset}`,
    `  ${C.gray}pentester under haksterAi${C.reset}`,
  ];

  // Merge ghost (green) with brand (cyan/gray) side by side
  const maxGhost = ghostLines.length;
  const maxBrand = brandLines.length;
  const maxLines = Math.max(maxGhost, maxBrand);

  for (let i = 0; i < maxLines; i++) {
    const ghost = i < maxGhost ? ghostLines[i] : '';
    const brand = i < maxBrand ? brandLines[i] : '';
    // Pad ghost line to consistent width, color it green
    const ghostPadded = ghost ? `${C.green}${ghost.padEnd(22)}${C.reset}` : '                      ';
    console.log(`${ghostPadded}${brand}`);
  }
  console.log();
}

module.exports = { showIntro, C };