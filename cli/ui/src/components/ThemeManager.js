// Theme definitions for the TUI
export const THEMES = {
  default: {
    bg: 'black',
    primary: 'green',
    secondary: 'cyan',
    accent: 'magenta',
    text: 'white',
    dim: 'gray',
    error: 'red',
    warning: 'yellow',
    success: 'green',
    info: 'blue',
    border: 'green',
    phase: {
      THINK: 'cyan', PLAN: 'yellow', ACT: 'green',
      OBSERVE: 'blue', REFLECT: 'magenta', CONSOLIDATE: 'gray',
      DONE: 'green', IDLE: 'gray', ERROR: 'red',
    },
  },
  dark: {
    bg: 'black',
    primary: 'blue',
    secondary: 'magenta',
    accent: 'cyan',
    text: 'white',
    dim: 'gray',
    error: 'red',
    warning: 'yellow',
    success: 'green',
    info: 'cyan',
    border: 'blue',
    phase: {
      THINK: 'blue', PLAN: 'yellow', ACT: 'green',
      OBSERVE: 'cyan', REFLECT: 'magenta', CONSOLIDATE: 'gray',
      DONE: 'green', IDLE: 'gray', ERROR: 'red',
    },
  },
  light: {
    bg: 'white',
    primary: 'blue',
    secondary: 'magenta',
    accent: 'cyan',
    text: 'black',
    dim: 'gray',
    error: 'red',
    warning: 'yellow',
    success: 'green',
    info: 'blue',
    border: 'blue',
    phase: {
      THINK: 'blue', PLAN: 'yellow', ACT: 'green',
      OBSERVE: 'cyan', REFLECT: 'magenta', CONSOLIDATE: 'gray',
      DONE: 'green', IDLE: 'gray', ERROR: 'red',
    },
  },
  cyberpunk: {
    bg: 'black',
    primary: 'magenta',
    secondary: 'cyan',
    accent: 'yellow',
    text: 'white',
    dim: 'gray',
    error: 'red',
    warning: 'yellow',
    success: 'cyan',
    info: 'magenta',
    border: 'magenta',
    phase: {
      THINK: 'magenta', PLAN: 'yellow', ACT: 'cyan',
      OBSERVE: 'blue', REFLECT: 'magenta', CONSOLIDATE: 'gray',
      DONE: 'cyan', IDLE: 'gray', ERROR: 'red',
    },
  },
  hacker: {
    bg: 'black',
    primary: 'green',
    secondary: 'green',
    accent: 'green',
    text: 'green',
    dim: 'gray',
    error: 'red',
    warning: 'green',
    success: 'green',
    info: 'green',
    border: 'green',
    phase: {
      THINK: 'green', PLAN: 'green', ACT: 'green',
      OBSERVE: 'green', REFLECT: 'green', CONSOLIDATE: 'green',
      DONE: 'green', IDLE: 'gray', ERROR: 'red',
    },
  },
};

export const THEME_NAMES = Object.keys(THEMES);

export function getTheme(name = 'default') {
  return THEMES[name] || THEMES.default;
}