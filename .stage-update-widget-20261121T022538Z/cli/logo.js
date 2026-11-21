// haksterAi ASCII logo — hooded ghost figure + brand text
// Colors use ANSI escape codes: cyberpunk green on black

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
  // Hooded ghost — matches the haksterAi logo shape
  // Rounded hood top, cloak draping down, dark eye sockets, wavy bottom
  const ghost = [
    "          .::::::::::.",
    "        .:::::::::::::.",
    "       .:::::::::::::::.",
    "       :::::::::::::::::",
    "      :::::::::::::::::::",
    "      ::    ______    :::",
    "      ::   |      |   :::",
    "      ::   | #### |   :::",
    "      ::   | #### |   :::",
    "      ::   |______|   :::",
    "      ::              :::",
    "      ::              :::",
    "       ::            ::",
    "        ::.        .::",
    "         ::.    .::",
    "        .::.  ...  .::.",
    "       ::  ::..::..::  ::",
    "      ::  .::      ::.  ::",
    "     ::  .::        ::.  ::",
    "    ::  .::          ::.  ::",
    "   ::  .::            ::.  ::",
    "  ::  .::              ::.  ::",
    " ::   ::                ::   ::",
    "  :::..::              ::..:::",
    "   ::::::              ::::::",
    "     ::::              ::::",
    "       ::                ::",
  ];

  const brandLines = [
    `  ${C.cyan}HAKSTERAI${C.reset}`,
    `  ${C.gray}═════════${C.reset}`,
    ``,
    `  ${C.gray}v${version}${C.reset}`,
    `  ${C.gray}pentester${C.reset}`,
    `  ${C.gray}under haksterAi${C.reset}`,
  ];

  const maxLines = Math.max(ghost.length, brandLines.length);

  for (let i = 0; i < maxLines; i++) {
    const g = i < ghost.length ? ghost[i] : '';
    const b = i < brandLines.length ? brandLines[i] : '';
    const gPadded = g ? `${C.green}${g.padEnd(30)}${C.reset}` : ''.padEnd(30);
    console.log(`${gPadded}${b}`);
  }
  console.log();
}

module.exports = { showIntro, C };