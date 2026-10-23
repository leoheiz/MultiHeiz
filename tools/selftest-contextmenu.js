'use strict';

/**
 * Self-test menu de contexto (templates puros + Electron listener).
 * Uso: npm run selftest:contextmenu
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const electronBin = require('electron');

function assert(cond, msg) {
  if (!cond) {
    console.log('FAIL:', msg);
    process.exit(1);
  }
}

function labelsOf(template) {
  return template.filter((t) => t.type !== 'separator').map((t) => t.label);
}

function idsOf(template) {
  return template.filter((t) => t.type !== 'separator').map((t) => t.id);
}

function runNodeTemplateChecks() {
  console.log('MultiHeiz selftest:contextmenu (node templates)');
  const {
    buildContextMenuTemplate,
    truncateForLabel,
    computeContextMenuPopupPoint,
    isEditableContext,
  } = require('../src/main/context-menu');

  // Coordenadas: painel direito = viewBounds + params (sem zoom extra)
  {
    const left = computeContextMenuPopupPoint({ x: 250, y: 80 }, { x: 10, y: 20 }, 1);
    assert(left.x === 260 && left.y === 100, 'left panel coords');
    const right = computeContextMenuPopupPoint({ x: 850, y: 80 }, { x: 10, y: 20 }, 1);
    assert(right.x === 860 && right.y === 100, 'right panel coords');
    assert(right.x !== left.x, 'left/right differ');
    // Bare params (bug antigo) cairiam no painel esquerdo
    assert(right.x !== 10, 'must not use bare params.x');
    console.log('PASS: popup coords viewBounds+params');
  }

  // formControlType / isEditable
  {
    assert(isEditableContext({ isEditable: true }) === true, 'isEditable');
    assert(isEditableContext({ isEditable: false, formControlType: 'text-area' }) === true, 'textarea');
    assert(isEditableContext({ isEditable: false, formControlType: 'text-field' }) === true, 'text-field');
    assert(isEditableContext({ isEditable: false, formControlType: 'none' }) === false, 'none');
    const t = buildContextMenuTemplate(
      { isEditable: false, formControlType: 'text-area', editFlags: { canPaste: true } },
      {}
    );
    assert(idsOf(t).includes('paste'), 'formControlType yields paste');
    console.log('PASS: isEditableContext + formControlType');
  }

  // Página simples
  {
    const t = buildContextMenuTemplate(
      { isEditable: false, selectionText: '', linkURL: '', mediaType: 'none' },
      { canGoBack: true, canGoForward: true }
    );
    const ids = idsOf(t);
    assert(ids.includes('back') && ids.includes('forward') && ids.includes('reload'), 'nav items');
    assert(ids.includes('inspect'), 'inspect');
    assert(!ids.includes('open-link'), 'no link');
    assert(!ids.includes('cut'), 'no edit');
    const sepCount = t.filter((x) => x.type === 'separator').length;
    assert(ids.includes('print'), 'print item');
    assert(sepCount === 2, 'separators around print/inspect, got ' + sepCount);
    console.log('PASS: página simples');
  }

  // Back/forward desabilitados
  {
    const t = buildContextMenuTemplate({}, { canGoBack: false, canGoForward: false });
    const back = t.find((x) => x.id === 'back');
    const fwd = t.find((x) => x.id === 'forward');
    assert(back && back.enabled === false, 'back disabled');
    assert(fwd && fwd.enabled === false, 'forward disabled');
    console.log('PASS: back/forward desabilitados');
  }

  // Editável com flags
  {
    const t = buildContextMenuTemplate(
      {
        isEditable: true,
        editFlags: {
          canUndo: true,
          canRedo: false,
          canCut: true,
          canCopy: true,
          canPaste: true,
          canPasteAndMatchStyle: true,
          canSelectAll: true,
        },
      },
      { canGoBack: false, canGoForward: false }
    );
    const ids = idsOf(t);
    for (const id of [
      'undo',
      'redo',
      'cut',
      'copy',
      'paste',
      'pasteAndMatchStyle',
      'selectAll',
    ]) {
      assert(ids.includes(id), 'edit id ' + id);
    }
    assert(t.find((x) => x.id === 'redo').enabled === false, 'redo disabled by flag');
    assert(t.find((x) => x.id === 'undo').enabled === true, 'undo enabled');
    const pasteMatch = t.find((x) => x.id === 'pasteAndMatchStyle');
    assert(pasteMatch && pasteMatch.label === 'Colar sem formatação', 'paste match label');
    console.log('PASS: editável com flags');
  }

  // Seleção
  {
    const long = 'abcdefghij klmnopqrst uvwxyz 0123456789 more';
    const t = buildContextMenuTemplate(
      { selectionText: long, isEditable: false },
      { canGoBack: true, canGoForward: false }
    );
    assert(idsOf(t).includes('copy'), 'copy selection');
    const search = t.find((x) => x.id === 'search-google');
    assert(search, 'search google');
    assert(search.label.includes('Pesquisar "'), 'search label prefix');
    assert(search.label.includes('…"') || search.label.includes('…'), 'ellipsis in snippet');
    assert(search.label.includes('no Google'), 'search google suffix');
    assert(truncateForLabel(long).endsWith('…'), 'truncate helper');
    console.log('PASS: seleção + pesquisar Google');
  }

  // Link http
  {
    const t = buildContextMenuTemplate(
      { linkURL: 'https://example.com/path', isEditable: false },
      {}
    );
    const open = t.find((x) => x.id === 'open-link');
    const copy = t.find((x) => x.id === 'copy-link');
    assert(open && open.enabled === true, 'open http link');
    assert(copy && copy.enabled === true, 'copy link');
    console.log('PASS: link http');
  }

  // Link javascript: / file: recusado
  {
    for (const bad of ['javascript:alert(1)', 'file:///C:/Windows']) {
      const t = buildContextMenuTemplate({ linkURL: bad }, {});
      const open = t.find((x) => x.id === 'open-link');
      assert(open && open.enabled === false, 'open refused for ' + bad);
      const copy = t.find((x) => x.id === 'copy-link');
      assert(copy && copy.enabled === true, 'copy still for ' + bad);
    }
    console.log('PASS: link javascript:/file: recusado');
  }

  // Imagem
  {
    const t = buildContextMenuTemplate(
      {
        mediaType: 'image',
        srcURL: 'https://example.com/a.png',
      },
      {}
    );
    const ids = idsOf(t);
    assert(ids.includes('open-image'), 'open image');
    assert(ids.includes('save-image'), 'save image');
    assert(ids.includes('copy-image'), 'copy image');
    assert(ids.includes('copy-image-url'), 'copy image url');
    assert(t.find((x) => x.id === 'open-image').enabled === true, 'open image enabled');
    console.log('PASS: imagem');
  }

  // Palavra errada + sugestões
  {
    const t = buildContextMenuTemplate(
      {
        misspelledWord: 'teh',
        dictionarySuggestions: ['the', 'tea'],
      },
      { canGoBack: true, canGoForward: true }
    );
    const labels = labelsOf(t);
    assert(labels[0] === 'the' || t[0].id === 'spell-replace', 'suggestion first');
    assert(idsOf(t).includes('spell-add'), 'add to dictionary');
    assert(t.find((x) => x.id === 'spell-add').label === 'Adicionar ao dicionário', 'add label');
    // Nav still present after suggestions
    assert(idsOf(t).includes('back'), 'nav after spell');
    // No duplicate separators
    for (let i = 1; i < t.length; i++) {
      assert(
        !(t[i].type === 'separator' && t[i - 1].type === 'separator'),
        'no duplicate separators'
      );
    }
    console.log('PASS: palavra errada com sugestões');
  }

  console.log('PASS: node template checks');
}

function runElectron() {
  const userdata = fs.mkdtempSync(path.join(os.tmpdir(), 'multiheiz-ctxmenu-'));
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      MULTIHEIZ_USERDATA: userdata,
      MULTIHEIZ_SELFTEST: 'contextmenu',
      MULTIHEIZ_UI_WIDTH: '1400',
      MULTIHEIZ_UI_HEIGHT: '900',
      ELECTRON_ENABLE_LOGGING: '1',
    };
    const child = spawn(electronBin, ['.'], {
      cwd: root,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let out = '';
    const onData = (buf) => {
      const s = buf.toString();
      out += s;
      process.stdout.write(s);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);

    const timer = setTimeout(() => {
      child.kill();
      try {
        fs.rmSync(userdata, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      reject(new Error('selftest:contextmenu electron timed out'));
    }, 120000);

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      try {
        fs.rmSync(userdata, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      if (code === 0) resolve(out);
      else reject(new Error(`selftest:contextmenu exited with code ${code}`));
    });
  });
}

async function main() {
  console.log('MultiHeiz selftest:contextmenu');
  try {
    runNodeTemplateChecks();
    await runElectron();
    console.log('PASS: selftest:contextmenu complete');
    process.exit(0);
  } catch (err) {
    console.error('FAIL:', err.message);
    process.exit(1);
  }
}

main();
