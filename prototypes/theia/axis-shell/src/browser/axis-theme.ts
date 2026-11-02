// "Axis Dark" colour theme built from the provisional tokens in docs/UX.md.
// Registered through Theia's Monaco theming service, so it drives both the
// workbench CSS variables (--theia-*) and the editor.
import { inject, injectable } from '@theia/core/shared/inversify';
import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { MonacoThemingService } from '@theia/monaco/lib/browser/monaco-theming-service';

export const AXIS_DARK_THEME_ID = 'axis-dark';

const t = {
    canvas: '#111214',
    surface: '#181A1D',
    raised: '#202227',
    border: '#2B2E34',
    text: '#E8E9EB',
    secondary: '#9A9EA7',
    muted: '#70757F',
    accent: '#5823F6',
    accentOnDark: '#9776F9',
    white: '#FFFFFF'
};

export const axisDarkColors: Record<string, string> = {
    'foreground': t.text,
    'descriptionForeground': t.secondary,
    'disabledForeground': t.muted,
    'focusBorder': t.accentOnDark,
    'contrastBorder': '#00000000',
    'widget.border': t.border,
    'textLink.foreground': t.accentOnDark,
    'textLink.activeForeground': t.accentOnDark,
    'icon.foreground': t.secondary,
    'selection.background': '#5823F666',
    'editor.background': t.canvas,
    'editor.foreground': t.text,
    'editorLineNumber.foreground': t.muted,
    'editorLineNumber.activeForeground': t.secondary,
    'editorCursor.foreground': t.accentOnDark,
    'editor.selectionBackground': '#5823F655',
    'editor.lineHighlightBackground': t.surface,
    'editorWidget.background': t.raised,
    'editorWidget.border': t.border,
    'editorGroup.border': t.border,
    'editorGroupHeader.tabsBackground': t.surface,
    'tab.activeBackground': t.canvas,
    'tab.inactiveBackground': t.surface,
    'tab.activeForeground': t.text,
    'tab.inactiveForeground': t.secondary,
    'tab.border': t.border,
    'tab.activeBorderTop': t.accentOnDark,
    'sideBar.background': t.surface,
    'sideBar.foreground': t.text,
    'sideBar.border': t.border,
    'sideBarSectionHeader.background': t.surface,
    'sideBarSectionHeader.border': t.border,
    'activityBar.background': t.surface,
    'activityBar.foreground': t.text,
    'activityBar.inactiveForeground': t.muted,
    'activityBar.activeBorder': t.accentOnDark,
    'activityBar.border': t.border,
    'activityBarBadge.background': t.accent,
    'activityBarBadge.foreground': t.white,
    'panel.background': t.surface,
    'panel.border': t.border,
    'panelTitle.activeForeground': t.text,
    'panelTitle.inactiveForeground': t.secondary,
    'panelTitle.activeBorder': t.accentOnDark,
    'titleBar.activeBackground': t.surface,
    'titleBar.activeForeground': t.text,
    'titleBar.border': t.border,
    'menubar.selectionBackground': t.raised,
    'menu.background': t.raised,
    'menu.foreground': t.text,
    'menu.selectionBackground': t.accent,
    'menu.selectionForeground': t.white,
    'menu.border': t.border,
    'statusBar.background': t.surface,
    'statusBar.foreground': t.secondary,
    'statusBar.border': t.border,
    'statusBar.noFolderBackground': t.surface,
    'statusBarItem.remoteBackground': t.accent,
    'statusBarItem.remoteForeground': t.white,
    'button.background': t.accent,
    'button.foreground': t.white,
    'button.hoverBackground': '#6A3AF7',
    'button.secondaryBackground': t.raised,
    'button.secondaryForeground': t.text,
    'badge.background': t.accent,
    'badge.foreground': t.white,
    'input.background': t.raised,
    'input.foreground': t.text,
    'input.border': t.border,
    'input.placeholderForeground': t.muted,
    'inputOption.activeBorder': t.accentOnDark,
    'dropdown.background': t.raised,
    'dropdown.border': t.border,
    'dropdown.foreground': t.text,
    'quickInput.background': t.raised,
    'quickInput.foreground': t.text,
    'quickInputList.focusBackground': '#5823F680',
    'list.activeSelectionBackground': '#5823F680',
    'list.activeSelectionForeground': t.text,
    'list.inactiveSelectionBackground': t.raised,
    'list.hoverBackground': t.raised,
    'list.focusOutline': t.accentOnDark,
    'progressBar.background': t.accentOnDark,
    'scrollbarSlider.background': '#70757F33',
    'scrollbarSlider.hoverBackground': '#70757F55',
    'scrollbarSlider.activeBackground': '#70757F77',
    'terminal.background': t.surface,
    'terminal.foreground': t.text,
    'terminalCursor.foreground': t.accentOnDark
};

const axisDarkTokenColors = [
    { scope: ['comment', 'punctuation.definition.comment'], settings: { foreground: t.muted, fontStyle: 'italic' } },
    { scope: ['keyword', 'storage', 'storage.type'], settings: { foreground: t.accentOnDark } },
    { scope: ['string', 'string.quoted'], settings: { foreground: '#A9D18E' } },
    { scope: ['constant.numeric', 'constant.language'], settings: { foreground: '#E5C07B' } },
    { scope: ['entity.name.function', 'support.function'], settings: { foreground: '#7FB4FF' } },
    { scope: ['entity.name.type', 'support.type', 'entity.name.class'], settings: { foreground: '#6FD3C8' } },
    { scope: ['variable', 'meta.definition.variable'], settings: { foreground: t.text } }
];

@injectable()
export class AxisThemeContribution implements FrontendApplicationContribution {

    @inject(MonacoThemingService)
    protected readonly monacoThemingService: MonacoThemingService;

    initialize(): void {
        this.monacoThemingService.registerParsedTheme({
            id: AXIS_DARK_THEME_ID,
            label: 'Axis Dark',
            uiTheme: 'vs-dark',
            description: 'Axis provisional dark tokens (docs/UX.md)',
            json: {
                name: 'Axis Dark',
                type: 'dark',
                colors: axisDarkColors,
                tokenColors: axisDarkTokenColors
            }
        });
    }
}
