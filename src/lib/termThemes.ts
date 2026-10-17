import type { ITheme } from '@xterm/xterm';

export type TermThemeDef = {
  id: string;
  name: string;
  /** Where the look comes from, shown under the name in the picker. */
  hint: string;
  /** Dark themes get light chrome (pane header, buttons) and Claude Code's dark theme. */
  dark: boolean;
  /** Pane border colour. */
  line: string;
  colors: Pick<
    ITheme,
    | 'background' | 'foreground'
    | 'black' | 'red' | 'green' | 'yellow' | 'blue' | 'magenta' | 'cyan' | 'white'
    | 'brightBlack' | 'brightRed' | 'brightGreen' | 'brightYellow' | 'brightBlue' | 'brightMagenta' | 'brightCyan' | 'brightWhite'
  >;
};

export const DEFAULT_TERM_THEME = 'paper';

export const TERM_THEMES: TermThemeDef[] = [
  {
    id: 'paper',
    name: 'Paper',
    hint: 'Studio’s warm light look',
    dark: false,
    line: 'rgba(29, 29, 31, 0.07)',
    colors: {
      background: '#fbf9f4', foreground: '#1d1d1f',
      black: '#1d1d1f', red: '#c8102e', green: '#1a7f45', yellow: '#9a5b00', blue: '#1d5fd1', magenta: '#7c3aed', cyan: '#0b7489', white: '#8e8e93',
      brightBlack: '#8a8780', brightRed: '#e5383b', brightGreen: '#23a35a', brightYellow: '#b87100', brightBlue: '#2f74f0', brightMagenta: '#9061f9', brightCyan: '#1192ad', brightWhite: '#3a3a3c',
    },
  },
  {
    id: 'ink',
    name: 'Ink black',
    hint: 'Studio’s near-black',
    dark: true,
    line: '#1f1f24',
    colors: {
      background: '#0e0e10', foreground: '#e9e6df',
      black: '#1d1d1f', red: '#ff6b6b', green: '#5fd4a0', yellow: '#f2c36b', blue: '#73a7ff', magenta: '#b794f6', cyan: '#62d0e6', white: '#d2d2d7',
      brightBlack: '#6e6e73', brightRed: '#ff8787', brightGreen: '#7fe3b6', brightYellow: '#f7d48f', brightBlue: '#99beff', brightMagenta: '#cdb2fa', brightCyan: '#8be0f0', brightWhite: '#ffffff',
    },
  },
  {
    id: 'midnight',
    name: 'Midnight blue',
    hint: 'Dark navy, like Claude Code',
    dark: true,
    line: '#1e2a44',
    colors: {
      background: '#0b1220', foreground: '#dbe4f5',
      black: '#16213a', red: '#ff7b86', green: '#6fdcae', yellow: '#f0c97a', blue: '#7aa9ff', magenta: '#c2a1ff', cyan: '#6ad4ea', white: '#c3cde0',
      brightBlack: '#5d6b8a', brightRed: '#ff98a0', brightGreen: '#8de8c1', brightYellow: '#f6d99a', brightBlue: '#9fc0ff', brightMagenta: '#d3bbff', brightCyan: '#8fe3f3', brightWhite: '#ffffff',
    },
  },
  {
    id: 'dark-plus',
    name: 'Dark+',
    hint: 'VS Code default dark',
    dark: true,
    line: '#2b2b2b',
    colors: {
      background: '#1e1e1e', foreground: '#cccccc',
      black: '#000000', red: '#cd3131', green: '#0dbc79', yellow: '#e5e510', blue: '#2472c8', magenta: '#bc3fbc', cyan: '#11a8cd', white: '#e5e5e5',
      brightBlack: '#666666', brightRed: '#f14c4c', brightGreen: '#23d18b', brightYellow: '#f5f543', brightBlue: '#3b8eea', brightMagenta: '#d670d6', brightCyan: '#29b8db', brightWhite: '#e5e5e5',
    },
  },
  {
    id: 'light-plus',
    name: 'Light+',
    hint: 'VS Code default light',
    dark: false,
    line: 'rgba(0, 0, 0, 0.1)',
    colors: {
      background: '#ffffff', foreground: '#333333',
      black: '#000000', red: '#cd3131', green: '#00bc00', yellow: '#949800', blue: '#0451a5', magenta: '#bc05bc', cyan: '#0598bc', white: '#555555',
      brightBlack: '#666666', brightRed: '#cd3131', brightGreen: '#14ce14', brightYellow: '#b5ba00', brightBlue: '#0451a5', brightMagenta: '#bc05bc', brightCyan: '#0598bc', brightWhite: '#a5a5a5',
    },
  },
  {
    id: 'one-dark',
    name: 'One Dark',
    hint: 'Atom / VS Code One Dark Pro',
    dark: true,
    line: '#2c313a',
    colors: {
      background: '#282c34', foreground: '#abb2bf',
      black: '#3f4451', red: '#e06c75', green: '#98c379', yellow: '#e5c07b', blue: '#61afef', magenta: '#c678dd', cyan: '#56b6c2', white: '#d7dae0',
      brightBlack: '#4f5666', brightRed: '#ff616e', brightGreen: '#a5e075', brightYellow: '#f0a45d', brightBlue: '#4dc4ff', brightMagenta: '#de73ff', brightCyan: '#4cd1e0', brightWhite: '#e6e6e6',
    },
  },
  {
    id: 'monokai',
    name: 'Monokai',
    hint: 'VS Code Monokai',
    dark: true,
    line: '#3e3d32',
    colors: {
      background: '#272822', foreground: '#f8f8f2',
      black: '#272822', red: '#f92672', green: '#a6e22e', yellow: '#f4bf75', blue: '#66d9ef', magenta: '#ae81ff', cyan: '#a1efe4', white: '#f8f8f2',
      brightBlack: '#75715e', brightRed: '#f92672', brightGreen: '#a6e22e', brightYellow: '#f4bf75', brightBlue: '#66d9ef', brightMagenta: '#ae81ff', brightCyan: '#a1efe4', brightWhite: '#f9f8f5',
    },
  },
  {
    id: 'dracula',
    name: 'Dracula',
    hint: 'Dracula',
    dark: true,
    line: '#343746',
    colors: {
      background: '#282a36', foreground: '#f8f8f2',
      black: '#21222c', red: '#ff5555', green: '#50fa7b', yellow: '#f1fa8c', blue: '#bd93f9', magenta: '#ff79c6', cyan: '#8be9fd', white: '#f8f8f2',
      brightBlack: '#6272a4', brightRed: '#ff6e6e', brightGreen: '#69ff94', brightYellow: '#ffffa5', brightBlue: '#d6acff', brightMagenta: '#ff92df', brightCyan: '#a4ffff', brightWhite: '#ffffff',
    },
  },
  {
    id: 'tokyo-night',
    name: 'Tokyo Night',
    hint: 'Tokyo Night',
    dark: true,
    line: '#232638',
    colors: {
      background: '#1a1b26', foreground: '#c0caf5',
      black: '#15161e', red: '#f7768e', green: '#9ece6a', yellow: '#e0af68', blue: '#7aa2f7', magenta: '#bb9af7', cyan: '#7dcfff', white: '#a9b1d6',
      brightBlack: '#414868', brightRed: '#f7768e', brightGreen: '#9ece6a', brightYellow: '#e0af68', brightBlue: '#7aa2f7', brightMagenta: '#bb9af7', brightCyan: '#7dcfff', brightWhite: '#c0caf5',
    },
  },
  {
    id: 'github-dark',
    name: 'GitHub Dark',
    hint: 'GitHub Dark Default',
    dark: true,
    line: '#21262d',
    colors: {
      background: '#0d1117', foreground: '#e6edf3',
      black: '#484f58', red: '#ff7b72', green: '#3fb950', yellow: '#d29922', blue: '#58a6ff', magenta: '#bc8cff', cyan: '#39c5cf', white: '#b1bac4',
      brightBlack: '#6e7681', brightRed: '#ffa198', brightGreen: '#56d364', brightYellow: '#e3b341', brightBlue: '#79c0ff', brightMagenta: '#d2a8ff', brightCyan: '#56d4dd', brightWhite: '#f0f6fc',
    },
  },
  {
    id: 'nord',
    name: 'Nord',
    hint: 'Nord',
    dark: true,
    line: '#3b4252',
    colors: {
      background: '#2e3440', foreground: '#d8dee9',
      black: '#3b4252', red: '#bf616a', green: '#a3be8c', yellow: '#ebcb8b', blue: '#81a1c1', magenta: '#b48ead', cyan: '#88c0d0', white: '#e5e9f0',
      brightBlack: '#4c566a', brightRed: '#bf616a', brightGreen: '#a3be8c', brightYellow: '#ebcb8b', brightBlue: '#81a1c1', brightMagenta: '#b48ead', brightCyan: '#8fbcbb', brightWhite: '#eceff4',
    },
  },
  {
    id: 'solarized-dark',
    name: 'Solarized Dark',
    hint: 'VS Code Solarized Dark',
    dark: true,
    line: '#0b4350',
    colors: {
      background: '#002b36', foreground: '#93a1a1',
      black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900', blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5',
      brightBlack: '#586e75', brightRed: '#cb4b16', brightGreen: '#586e75', brightYellow: '#657b83', brightBlue: '#839496', brightMagenta: '#6c71c4', brightCyan: '#93a1a1', brightWhite: '#fdf6e3',
    },
  },
  {
    id: 'solarized-light',
    name: 'Solarized Light',
    hint: 'VS Code Solarized Light',
    dark: false,
    line: 'rgba(101, 123, 131, 0.25)',
    colors: {
      background: '#fdf6e3', foreground: '#586e75',
      black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900', blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#93a1a1',
      brightBlack: '#586e75', brightRed: '#cb4b16', brightGreen: '#586e75', brightYellow: '#657b83', brightBlue: '#839496', brightMagenta: '#6c71c4', brightCyan: '#586e75', brightWhite: '#002b36',
    },
  },
];

export function termThemeDef(id: string | undefined): TermThemeDef {
  return TERM_THEMES.find((t) => t.id === id) || TERM_THEMES[0];
}
