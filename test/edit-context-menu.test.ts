import { describe, expect, it } from 'vitest';

import { editContextMenuTemplate } from '../src/main/edit-context-menu.js';

const flags = { canUndo: true, canRedo: true, canCut: true, canCopy: true, canPaste: true, canDelete: true, canSelectAll: true, canEditRichly: false };

describe('native editable context menu', () => {
  it('uses native edit roles without reading clipboard data or replacing the selection', () => {
    const menu = editContextMenuTemplate({ isEditable: true, editFlags: flags });
    expect(menu).toEqual([
      { role: 'cut', enabled: true }, { role: 'copy', enabled: true },
      { role: 'paste', enabled: true }, { role: 'selectAll', enabled: true }
    ]);
    expect(menu.every(item => !item.click)).toBe(true);
  });

  it('reflects the actual selection, clipboard and empty-field capabilities', () => {
    const empty = editContextMenuTemplate({ isEditable: true, editFlags: { ...flags, canCut: false, canCopy: false, canPaste: false, canSelectAll: false } });
    expect(empty.every(item => item.enabled === false)).toBe(true);
    const imageClipboard = editContextMenuTemplate({ isEditable: true, editFlags: { ...flags, canCut: false, canCopy: false } });
    expect(imageClipboard.map(item => [item.role, item.enabled])).toEqual([
      ['cut', false], ['copy', false], ['paste', true], ['selectAll', true]
    ]);
  });

  it('does not present editing actions over transcript content or other non-editable UI', () => {
    expect(editContextMenuTemplate({ isEditable: false, editFlags: flags })).toEqual([]);
  });

  ;
});
