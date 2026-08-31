import type { EditorTheme, MarkdownTheme, SelectListTheme, SettingsListTheme } from "@earendil-works/pi-tui";

// 最小 ANSI 主题：不引入额外依赖
const wrap =
	(code: string) =>
	(text: string): string =>
		`\x1b[${code}m${text}\x1b[0m`;

export const colors = {
	cyan: wrap("36"),
	green: wrap("32"),
	red: wrap("31"),
	yellow: wrap("33"),
	dim: wrap("2"),
	bold: wrap("1"),
};

export const selectListTheme: SelectListTheme = {
	selectedPrefix: colors.cyan,
	selectedText: colors.cyan,
	description: colors.dim,
	scrollInfo: colors.dim,
	noMatch: colors.dim,
};

export const editorTheme: EditorTheme = {
	borderColor: colors.dim,
	selectList: selectListTheme,
};

export const settingsListTheme: SettingsListTheme = {
	label: (text, selected) => (selected ? colors.cyan(text) : text),
	value: (text, selected) => (selected ? colors.cyan(text) : colors.dim(text)),
	description: colors.dim,
	cursor: colors.cyan("→ "),
	hint: colors.dim,
};

/** 弹窗统一锚定在输入框上方：底部居中 + 负向抬升越过编辑器/状态栏区域 */
export const dialogOverlayOptions = { anchor: "bottom-center" as const, offsetY: -6 };

export const markdownTheme: MarkdownTheme = {
	heading: colors.bold,
	link: colors.cyan,
	linkUrl: colors.dim,
	code: colors.yellow,
	codeBlock: (text) => text,
	codeBlockBorder: colors.dim,
	quote: colors.dim,
	quoteBorder: colors.dim,
	hr: colors.dim,
	listBullet: colors.cyan,
	bold: colors.bold,
	italic: (text) => text,
	strikethrough: (text) => text,
	underline: wrap("4"),
};
