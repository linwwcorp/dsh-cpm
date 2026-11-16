window.__ModuleLoader__.load({
  id: 'dsh-cpm',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useRef, useState, useSyncExternalStore } = React

    const NS = 'cpm'
    const PANEL_ID = 'cpm'
    const API_URL = '/api/cpm/records'
    /** Upload bodies are relayed to object storage; without a bound a stalled store spins forever. */
    const UPLOAD_TIMEOUT_MS = 180000
    const ARCHS = ['X86', 'ARM64', 'RISC-V']
    const RESOURCE_ARCHS = ['X86', 'ARM64', 'RISC-V']
    const CARDS = ['CPU', 'NVIDIA', '天数', '华为']
    const ACCELS = ['CPU', 'NVIDIA', '天数', '华为']

    const COPY = {
      en: { panel: 'Resources' },
      zh: { panel: '资源管理' },
    }

    const sha256 = (text) => {
      const rot = (value, bits) => (value >>> bits) | (value << (32 - bits))
      const k = []
      const hash = []
      const composite = {}
      for (let candidate = 2, count = 0; count < 64; candidate += 1) {
        if (composite[candidate]) continue
        for (let index = 0; index < 313; index += candidate) composite[index] = candidate
        hash[count] = (Math.pow(candidate, 0.5) * 4294967296) | 0
        k[count] = (Math.pow(candidate, 1 / 3) * 4294967296) | 0
        count += 1
      }
      const bitLength = text.length * 8
      let padded = `${text}\x80`
      while ((padded.length % 64) !== 56) padded += '\x00'
      const words = []
      for (let index = 0; index < padded.length; index += 1) words[index >> 2] = (words[index >> 2] || 0) | (padded.charCodeAt(index) << ((3 - (index % 4)) * 8))
      words[words.length] = (bitLength / 4294967296) | 0
      words[words.length] = bitLength
      for (let offset = 0; offset < words.length;) {
        const w = words.slice(offset, offset += 16)
        const previous = hash.slice(0, 8)
        for (let index = 0; index < 64; index += 1) {
          const a = hash[0]
          const e = hash[4]
          const w15 = w[index - 15]
          const w2 = w[index - 2]
          const extra = index < 16 ? w[index] : (w[index - 16] + (rot(w15, 7) ^ rot(w15, 18) ^ (w15 >>> 3)) + w[index - 7] + (rot(w2, 17) ^ rot(w2, 19) ^ (w2 >>> 10))) | 0
          w[index] = extra
          const temp1 = (hash[7] + (rot(e, 6) ^ rot(e, 11) ^ rot(e, 25)) + ((e & hash[5]) ^ (~e & hash[6])) + k[index] + extra) | 0
          const temp2 = ((rot(a, 2) ^ rot(a, 13) ^ rot(a, 22)) + ((a & hash[1]) ^ (a & hash[2]) ^ (hash[1] & hash[2]))) | 0
          hash.pop()
          hash.unshift((temp1 + temp2) | 0)
          hash[4] = (hash[4] + temp1) | 0
        }
        for (let index = 0; index < 8; index += 1) hash[index] = (hash[index] + previous[index]) | 0
      }
      return hash.slice(0, 8).map(word => (word >>> 0).toString(16).padStart(8, '0')).join('')
    }

    const feedTerminal = (screen, chunk) => {
      const rows = screen.rows.slice()
      let row = screen.row
      let col = screen.col
      const ensure = () => { while (rows.length <= row) rows.push('') }
      const write = (ch) => {
        ensure()
        const chars = Array.from(rows[row])
        while (chars.length < col) chars.push(' ')
        chars[col] = ch
        rows[row] = chars.join('')
        col += 1
      }
      for (let index = 0; index < chunk.length; index += 1) {
        const ch = chunk[index]
        if (ch === '\u001b') {
          if (chunk[index + 1] === '[') {
            index += 2
            let params = ''
            while (index < chunk.length && !/[@-~]/.test(chunk[index])) { params += chunk[index]; index += 1 }
            const command = chunk[index] || ''
            const parts = params.split(';').map(item => Number(item || '0'))
            ensure()
            if (command === 'K') rows[row] = rows[row].slice(0, col)
            else if (command === 'G') col = Math.max(0, (parts[0] || 1) - 1)
            else if (command === 'C') col += parts[0] || 1
            else if (command === 'D') col = Math.max(0, col - (parts[0] || 1))
            else if (command === 'A') row = Math.max(0, row - (parts[0] || 1))
            else if (command === 'B') row += parts[0] || 1
          } else if (chunk[index + 1] === ']') {
            index += 2
            while (index < chunk.length && chunk[index] !== '\u0007') index += 1
          }
          continue
        }
        if (ch === '\r') { col = 0; continue }
        if (ch === '\n') { row += 1; col = 0; continue }
        if (ch === '\b' || ch === '\u007f') { col = Math.max(0, col - 1); continue }
        if (ch < ' ') continue
        write(ch)
      }
      if (rows.length > 400) {
        const extra = rows.length - 400
        rows.splice(0, extra)
        row = Math.max(0, row - extra)
      }
      return { rows, row, col }
    }

    const PAGE_CSS = `
      .dsh-cpm { box-sizing: border-box; display: flex; flex-direction: column; width: 100%; height: 100%; min-height: 0; overflow: hidden; background: #f7f8fa; color: #1d2129; font-size: 14px; }
      .dsh-cpm-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 16px 0; background: #fff; }
      .dsh-cpm-head h1 { margin: 0; font-size: 18px; font-weight: 600; }
      .dsh-cpm-tabs { position: relative; box-sizing: border-box; display: grid; grid-template-columns: repeat(3, 1fr); width: 432px; margin: 12px 16px 0; padding: 4px; border-radius: 10px; background: #f2f3f5; }
      .dsh-cpm-tab-slider { position: absolute; top: 4px; bottom: 4px; left: 4px; width: calc((100% - 8px) / 3); border-radius: 8px; background: #fff; box-shadow: 0 1px 2px rgba(29, 33, 41, .08); transition: transform .22s ease; }
      .dsh-cpm-tab { position: relative; z-index: 1; height: 32px; padding: 0 16px; border: 0; border-radius: 8px; background: transparent; color: #4e5969; font: inherit; font-size: 14px; cursor: pointer; }
      .dsh-cpm-tab[data-active='true'] { color: #1d2129; font-weight: 600; }
      .dsh-cpm-toolbar { display: flex; align-items: center; justify-content: flex-end; gap: 8px; margin: 12px 16px 0; padding: 10px 12px; background: #fff; border: 1px solid #e5e6eb; border-radius: 16px; }
      .dsh-cpm-toolbar .dsh-cpm-btn { border-radius: 16px; }
      .dsh-cpm-toolbar .dsh-cpm-search input { border-radius: 16px 0 0 16px; }
      .dsh-cpm-toolbar .dsh-cpm-search .dsh-cpm-btn { border-radius: 0 16px 16px 0; }
      .dsh-cpm-file-tools { display: flex; align-items: center; gap: 8px; margin-right: auto; }
      .dsh-cpm-summary { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 14px; margin-right: auto; color: #4e5969; font-size: 13px; }
      .dsh-cpm-summary b { color: #1d2129; font-weight: 650; }
      .dsh-cpm-summary [data-kind="正常"] b { color: #0f766e; }
      .dsh-cpm-summary [data-kind="异常"] b { color: #c92a2a; }
      .dsh-cpm-summary [data-kind="启动中"] b { color: #1c7ed6; }
      .dsh-cpm-search { display: flex; }
      .dsh-cpm-search input { width: 220px; height: 32px; padding: 0 10px; border: 1px solid #e5e6eb; border-right: 0; border-radius: 8px 0 0 8px; background: #fff; font: inherit; }
      .dsh-cpm-search .dsh-cpm-btn { border-radius: 0 8px 8px 0; }
      .dsh-cpm-main { flex: 1; min-height: 0; overflow: auto; padding: 0 16px 16px; }
      .dsh-cpm-foot { display: flex; flex: 0 0 40px; align-items: center; gap: 8px; height: 40px; padding: 0 12px; background: #fff; border-top: 1px solid #e5e6eb; color: #4e5969; font-size: 12px; }
      .dsh-cpm-btn { height: 32px; padding: 0 12px; border: 1px solid #e5e6eb; border-radius: 8px; background: #fff; color: #1d2129; font: inherit; font-size: 13px; cursor: pointer; }
      .dsh-cpm-btn:disabled { opacity: .45; cursor: default; }
      .dsh-cpm-primary { border-color: #528eff; background: #528eff; color: #fff; }
      .dsh-cpm-search .dsh-cpm-btn { border-radius: 0 8px 8px 0; }
      .dsh-cpm-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 14px; }
      .dsh-cpm-cards[data-gap='true'] { margin-top: 20px; }
      .dsh-cpm-card { border: 0.5px solid #e5e6eb; border-radius: 12px; background: #fff; overflow: hidden; cursor: pointer; }
      .dsh-cpm-card:hover { border-color: #528eff; }
      .dsh-cpm-card-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; padding: 12px 12px 0; }
      .dsh-cpm-card h3 { margin: 8px 12px 0; font-size: 15px; }
      .dsh-cpm-card p { margin: 8px 12px 12px; color: #86909c; font-size: 12px; }
      .dsh-cpm-pills { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 12px 0; }
      .dsh-cpm-pill { display: inline-flex; align-items: center; height: 22px; padding: 0 8px; border-radius: 999px; background: #f2f3f5; color: #4e5969; font-size: 12px; }
      .dsh-cpm-pill.accent { background: #f2f7ff; color: #528eff; }
      .dsh-cpm-status { border-radius: 999px; padding: 0 8px; height: 22px; display: inline-flex; align-items: center; font-size: 12px; background: #e8f3ff; color: #1c7ed6; }
      .dsh-cpm-status[data-status='正常'] { background: #e8ffea; color: #00b42a; }
      .dsh-cpm-status[data-status='异常'] { background: #ffece8; color: #f53f3f; }
      .dsh-cpm-usage { display: grid; gap: 6px; margin: 10px 12px 0; font-size: 12px; color: #4e5969; }
      .dsh-cpm-usage div { display: grid; grid-template-columns: 32px 1fr 42px; gap: 6px; align-items: center; }
      .dsh-cpm-bar { height: 4px; border-radius: 99px; background: #f2f3f5; overflow: hidden; }
      .dsh-cpm-bar i { display: block; height: 100%; background: #528eff; }
      .dsh-cpm-actions { display: flex; gap: 4px; }
      .dsh-cpm-icon { width: 28px; height: 28px; border: 0; border-radius: 8px; background: #f2f3f5; cursor: pointer; }
      .dsh-cpm-stats { display: grid; grid-template-columns: 280px 1fr; gap: 12px; }
      .dsh-cpm-panel { padding: 16px; border-radius: 12px; background: #fff; }
      .dsh-cpm-panel h2 { margin: 0 0 12px; font-size: 14px; }
      .dsh-cpm-metrics { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
      .dsh-cpm-stat strong { display: block; margin-top: 6px; font-size: 28px; }
      .dsh-cpm-stat span, .dsh-cpm-stat p { color: #86909c; font-size: 12px; }
      .dsh-cpm-pie { width: 140px; height: 140px; border-radius: 50%; display: grid; place-items: center; }
      .dsh-cpm-pie b { width: 86px; height: 86px; border-radius: 50%; background: #fff; display: grid; place-items: center; text-align: center; }
      .dsh-cpm-legend { list-style: none; margin: 12px 0 0; padding: 0; display: grid; gap: 6px; font-size: 13px; }
      .dsh-cpm-legend li { display: flex; align-items: center; gap: 8px; }
      .dsh-cpm-legend i { width: 8px; height: 8px; border-radius: 50%; }
      .dsh-cpm-quick { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 12px; }
      .dsh-cpm-quick button { padding: 16px; border: 0.5px solid #e5e6eb; border-radius: 12px; background: #fff; text-align: left; cursor: pointer; font: inherit; }
      .dsh-cpm-quick button:hover { border-color: #528eff; }
      .dsh-cpm-quick strong { display: block; }
      .dsh-cpm-quick span { color: #86909c; font-size: 12px; }
      .dsh-cpm-size { position: relative; }
      .dsh-cpm-size-btn { height: 28px; padding: 0 12px; border: 1px solid #e5e6eb; border-radius: 999px; background: #fff; font: inherit; font-size: 12px; cursor: pointer; }
      .dsh-cpm-menu { position: absolute; left: 0; bottom: 34px; z-index: 20; width: max-content; min-width: 100%; padding: 6px; border: 1px solid #e5e6eb; border-radius: 16px; background: #fff; box-shadow: 0 8px 24px rgba(0,0,0,.08); }
      .dsh-cpm-menu.down { top: 36px; bottom: auto; }
      .dsh-cpm-menu button { display: block; width: 100%; height: 32px; padding: 0 12px; border: 0; border-radius: 999px; background: transparent; text-align: left; font: inherit; font-size: 12px; white-space: nowrap; cursor: pointer; }
      .dsh-cpm-sort { min-width: 148px; }
      .dsh-cpm-filter .dsh-cpm-size-btn { width: 100%; height: 32px; border-radius: 8px; font-size: 13px; text-align: left; }
      .dsh-cpm-filter .dsh-cpm-menu { border-radius: 8px; }
      .dsh-cpm-filter .dsh-cpm-menu button { border-radius: 8px; }
      .dsh-cpm-menu button:hover, .dsh-cpm-menu button[data-active='true'] { background: #f2f7ff; color: #528eff; }
      .dsh-cpm-overlay { position: fixed; inset: 0; z-index: 40; display: grid; place-items: center; padding: 24px; background: rgba(29,33,41,.3); }
      .dsh-cpm-dialog { width: min(560px, 100%); max-height: min(820px, calc(100vh - 48px)); display: flex; flex-direction: column; border-radius: 16px; background: #fff; }
      .dsh-cpm-dialog.wide { width: min(960px, calc(100vw - 48px)); }
      .dsh-cpm-deploy { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
      .dsh-cpm-deploy .dsh-cpm-area { min-height: 280px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
      .dsh-cpm-log { margin: 0; min-height: 320px; max-height: 420px; padding: 12px; border-radius: 8px; background: #1b2433; color: #d6deeb; overflow: auto; white-space: pre-wrap; font-size: 12px; line-height: 1.5; }
      .dsh-cpm-hint { margin: 4px 0 0; color: #86909c; font-size: 12px; }
      .dsh-cpm-body { overflow: auto; }
      .dsh-cpm-choices { display: flex; flex-wrap: wrap; gap: 8px; }
      .dsh-cpm-choice { height: 32px; padding: 0 14px; border: 1px solid #e5e6eb; border-radius: 999px; background: #fff; color: #1d2129; font: inherit; font-size: 13px; cursor: pointer; }
      .dsh-cpm-choice[data-active='true'] { border-color: #528eff; background: #528eff; color: #fff; }
      .dsh-cpm-upload { display: flex; align-items: center; gap: 12px; }
      .dsh-cpm-upload-btn { display: grid; place-items: center; width: 72px; height: 72px; border: 1px dashed #c9cdd4; border-radius: 12px; background: #f7f8fa; color: #86909c; font-size: 12px; cursor: pointer; overflow: hidden; }
      .dsh-cpm-upload-btn img { width: 100%; height: 100%; object-fit: cover; }
      .dsh-cpm-dialog h2 { display: flex; justify-content: space-between; align-items: center; margin: 0; padding: 16px 18px 8px; font-size: 16px; }
      .dsh-cpm-body { display: grid; gap: 12px; padding: 8px 18px 16px; }
      .dsh-cpm-field { display: grid; gap: 6px; }
      .dsh-cpm-field span { color: #86909c; font-size: 12px; }
      .dsh-cpm-input, .dsh-cpm-area { box-sizing: border-box; width: 100%; border: 1px solid #e5e6eb; border-radius: 8px; background: #fff; font: inherit; font-size: 13px; }
      .dsh-cpm-input { height: 32px; padding: 0 10px; }
      .dsh-cpm-folder-input, .dsh-cpm-folder-input:focus { box-sizing: border-box; width: 100%; height: 36px; padding: 0 12px; border: 1px solid #e5e6eb !important; border-radius: 10px !important; outline: none !important; box-shadow: none !important; background: #fff; color: #1d2129; font: inherit; font-size: 13px; }
      .dsh-cpm-input[data-invalid='true'], .dsh-cpm-area[data-invalid='true'], .dsh-cpm-size-btn[data-invalid='true'] { border-color: #f53f3f; }
      .dsh-cpm-choices[data-invalid='true'] { padding: 4px; border-radius: 12px; outline: 1px solid #f53f3f; }
      .dsh-cpm-upload-btn[data-invalid='true'] { border-color: #f53f3f; border-style: solid; }
      .dsh-cpm-area { min-height: 88px; padding: 8px 10px; resize: vertical; }
      .dsh-cpm-card { position: relative; }
      .dsh-cpm-card-icon { width: 56px; height: 56px; border-radius: 12px; object-fit: cover; background: #f2f7ff; }
      .dsh-cpm-card-ops { position: absolute; top: 8px; right: 8px; display: none; gap: 4px; padding: 4px; border-radius: 10px; background: rgba(29,33,41,.72); }
      .dsh-cpm-card:hover .dsh-cpm-card-ops { display: flex; }
      .dsh-cpm-card-ops button { display: grid; place-items: center; width: 28px; height: 28px; padding: 0; border: 0; border-radius: 8px; background: transparent; color: #fff; cursor: pointer; }
      .dsh-cpm-card-ops svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
      .dsh-cpm-card-ops button:hover { background: rgba(255,255,255,.16); }
      .dsh-cpm-detail { display: grid; gap: 12px; }
      .dsh-cpm-detail-head { display: flex; align-items: center; gap: 12px; }
      .dsh-cpm-identity { display: flex; align-items: center; gap: 12px; margin: 0; padding: 0; border: 0; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }
      .dsh-cpm-detail-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; align-items: start; }
      .dsh-cpm-metric { display: flex; flex-direction: column; align-items: stretch; }
      .dsh-cpm-metric-big { margin: 0 0 8px; font-size: 16px; font-weight: 600; line-height: 1.2; }
      .dsh-cpm-metric .dsh-cpm-bar { height: 8px; flex: none; width: 100%; margin: 0 0 12px; }
      .dsh-cpm-kv { display: grid; gap: 6px; margin: 0; }
      .dsh-cpm-kv > div { display: grid; grid-template-columns: 64px minmax(0, 1fr); gap: 8px; font-size: 13px; }
      .dsh-cpm-kv dt { margin: 0; color: #86909c; }
      .dsh-cpm-kv dd { margin: 0; }
      .dsh-cpm-file-meta dt { color: #86909c; }
      .dsh-cpm-file-meta dd { color: #4e5969; }
      .dsh-cpm-table { width: 100%; border-collapse: collapse; font-size: 13px; }
      .dsh-cpm-table th, .dsh-cpm-table td { padding: 8px 10px; border-bottom: 1px solid #f2f3f5; text-align: left; }
      .dsh-cpm-usage-cell { display: flex; align-items: center; gap: 8px; min-width: 140px; }
      .dsh-cpm-usage-cell .dsh-cpm-bar { flex: 1; height: 8px; }
      .dsh-cpm-table th { color: #86909c; font-weight: 500; }
      .dsh-cpm-toolbar-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: flex-end; margin-bottom: 12px; }
      .dsh-cpm-toolbar-end { display: flex; align-items: flex-end; gap: 8px; margin-left: auto; }
      .dsh-cpm-toolbar-row label, .dsh-cpm-filter { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: #86909c; }
      .dsh-cpm-toolbar-row input, .dsh-cpm-toolbar-row select { height: 32px; border: 1px solid #e5e6eb; border-radius: 8px; padding: 0 8px; font: inherit; color: #1d2129; background: #fff; }
      .dsh-cpm-batch { position: relative; }
      .dsh-cpm-batch-menu { position: absolute; z-index: 5; top: 36px; right: 0; min-width: 120px; padding: 4px; border-radius: 10px; background: #fff; box-shadow: 0 8px 24px rgba(29,33,41,.12); }
      .dsh-cpm-batch-menu button, .dsh-cpm-link { border: 0; background: transparent; color: #528eff; font: inherit; font-size: 13px; cursor: pointer; }
      .dsh-cpm-batch-menu button { display: block; width: 100%; text-align: left; padding: 6px 8px; border-radius: 8px; color: #1d2129; }
      .dsh-cpm-batch-menu button:hover { background: #f2f7ff; }
      .dsh-cpm-state[data-state="running"] { color: #0f766e; }
      .dsh-cpm-state[data-state="exited"], .dsh-cpm-state[data-state="dead"] { color: #c92a2a; }
      .dsh-cpm-overlay { position: fixed; inset: 0; z-index: 40; display: flex; align-items: center; justify-content: center; background: rgba(29,33,41,.28); }
      .dsh-cpm-float { width: min(860px, calc(100vw - 48px)); max-height: min(640px, calc(100vh - 48px)); display: flex; flex-direction: column; background: #fff; border-radius: 16px; }
      .dsh-cpm-float pre { margin: 0; padding: 12px 16px 16px; overflow: auto; white-space: pre-wrap; font-size: 12px; line-height: 1.5; }
      .dsh-cpm-term { position: relative; display: flex; flex-direction: column; max-width: calc(100vw - 48px); background: #fff; border-radius: 12px; overflow: hidden; }
      .dsh-cpm-resize { position: absolute; right: 2px; bottom: 2px; width: 16px; height: 16px; cursor: nwse-resize; background: linear-gradient(135deg, transparent 50%, #c9cdd4 50%, #c9cdd4 62%, transparent 62%, transparent 74%, #c9cdd4 74%); }
      .dsh-cpm-term-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 16px 18px 12px; cursor: move; user-select: none; }
      .dsh-cpm-term-head h3 { margin: 0; font-size: 16px; }
      .dsh-cpm-term-head p { margin: 4px 0 0; color: #86909c; font-size: 12px; }
      .dsh-cpm-term-main { display: flex; flex: 1; min-height: 0; margin: 0 16px 16px; gap: 12px; }
      .dsh-cpm-term-files { flex: none; min-width: 0; min-height: 0; overflow: auto; border: 1px solid #e5e6eb; border-radius: 8px; background: #fff; padding: 8px; }
      .dsh-cpm-term-split { flex: none; width: 12px; margin: 0 -6px; cursor: col-resize; position: relative; }
      .dsh-cpm-term-split::after { content: ''; position: absolute; left: 5px; top: 8px; bottom: 8px; width: 2px; border-radius: 99px; background: #e5e6eb; }
      .dsh-cpm-term-files[data-drop='true'] { background: #e5e6eb; }
      .dsh-cpm-term-line { display: flex; align-items: center; width: 100%; min-width: 0; border-radius: 4px; }
      .dsh-cpm-term-line:hover, .dsh-cpm-term-line[data-on='true'] { background: #e5e6eb; }
      .dsh-cpm-term-line .dsh-cpm-term-entry { background: transparent; }
      .dsh-cpm-term-line .dsh-cpm-term-entry:hover { background: transparent; }
      .dsh-cpm-term-menu { position: fixed; z-index: 80; min-width: 148px; padding: 6px; border-radius: 8px; background: #fff; box-shadow: 0 8px 24px rgba(29,33,41,.16); }
      .dsh-cpm-term-menu button { display: block; width: 100%; height: 30px; padding: 0 10px; border: 0; border-radius: 6px; background: transparent; color: #1d2129; font: inherit; font-size: 12px; text-align: left; cursor: pointer; }
      .dsh-cpm-term-menu button:hover { background: #f2f3f5; }
      .dsh-cpm-term-menu button:disabled { color: #c9cdd4; cursor: default; }
      .dsh-cpm-term-menu button:disabled:hover { background: transparent; }
      .dsh-cpm-term-menu hr { height: 0; margin: 4px 6px; border: 0; border-top: 1px solid #e5e6eb; }
      .dsh-cpm-xfer { flex: none; height: 148px; margin: 0 16px 12px; overflow: auto; border: 1px solid #e5e6eb; border-radius: 8px; background: #fff; }
      .dsh-cpm-xfer-row { display: grid; grid-template-columns: 36px 44px minmax(0, 1fr) 88px 64px 72px 64px; gap: 8px; align-items: center; height: 32px; padding: 0 8px; font-size: 12px; }
      .dsh-cpm-xfer-row[data-on='true'] { background: #e5e6eb; }
      .dsh-cpm-xfer-row[data-status='done'] { background: #e8ffea; color: #00b42a; }
      .dsh-cpm-xfer-row[data-status='error'] { background: #ffece8; color: #f53f3f; }
      .dsh-cpm-xfer-head { position: sticky; top: 0; z-index: 1; background: #f7f8fa; color: #86909c; }
      .dsh-cpm-xfer-row span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .dsh-cpm-xfer-bar { height: 6px; border-radius: 99px; background: #f2f3f5; overflow: hidden; }
      .dsh-cpm-xfer-bar i { display: block; height: 100%; background: #528eff; }
      .dsh-cpm-term-files p { margin: 0; color: #86909c; font-size: 12px; }
      .dsh-cpm-term-file { display: flex; align-items: center; gap: 4px; min-width: 0; }
      .dsh-cpm-term-entry { display: flex; align-items: center; gap: 6px; flex: 1; min-width: 0; min-height: 26px; padding: 0 4px; border: 0; border-radius: 4px; background: transparent; color: #1d2129; font: inherit; font-size: 12px; text-align: left; cursor: pointer; }
      .dsh-cpm-term-entry span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .dsh-cpm-term-entry[data-kind='file'] { cursor: default; color: #4e5969; }
      .dsh-cpm-term-size { flex: none; color: #86909c; font-size: 11px; }
      .dsh-cpm-term-down { flex: none; display: grid; place-items: center; width: 22px; height: 22px; padding: 0; border: 0; border-radius: 4px; background: transparent; color: #4e5969; cursor: pointer; }
      .dsh-cpm-term-down:hover { background: #f2f3f5; color: #528eff; }
      .dsh-cpm-term-body { flex: 1; min-width: 0; min-height: 0; margin: 0; padding: 16px; overflow: auto; border-radius: 8px; background: #151b26; color: #e8eef7; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; line-height: 1.45; white-space: pre; outline: none; }
      .dsh-cpm-term-body pre { margin: 0; white-space: pre; font: inherit; }
      .dsh-cpm-loading { display: flex; align-items: center; gap: 8px; padding: 28px 0; color: #86909c; }
      .dsh-cpm-spin { width: 16px; height: 16px; border: 2px solid #e5e6eb; border-top-color: #528eff; border-radius: 50%; animation: dsh-cpm-spin .8s linear infinite; }
      @keyframes dsh-cpm-spin { to { transform: rotate(360deg); } }
      .dsh-cpm-term-row { display: flex; align-items: center; margin: 0; white-space: pre; }
      .dsh-cpm-term-input { position: absolute; width: 1px; height: 1px; opacity: 0; border: 0; padding: 0; }
      .dsh-cpm-caret { background: #e8eef7; color: #151b26; animation: dsh-cpm-caret 1s step-end infinite; }
      @keyframes dsh-cpm-caret { 50% { background: transparent; color: inherit; } }
      .dsh-cpm-usage span[data-level="ok"] { color: #2f9e44; }
      .dsh-cpm-usage span[data-level="warn"] { color: #f59f00; }
      .dsh-cpm-usage span[data-level="danger"] { color: #f53f3f; }
      .dsh-cpm-bar i[data-level="ok"] { background: #2f9e44; }
      .dsh-cpm-bar i[data-level="warn"] { background: #f59f00; }
      .dsh-cpm-bar i[data-level="danger"] { background: #f53f3f; }
      .dsh-cpm-section-head { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; }
      .dsh-cpm-section-head h2 { margin: 0; }
      .dsh-cpm-gpu-title { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; margin-bottom: 14px; }
      .dsh-cpm-gpu-title p { margin: 4px 0 0; color: #86909c; font-size: 12px; }
      .dsh-cpm-gpu-temp { padding: 4px 10px; border-radius: 999px; font-size: 13px; font-weight: 600; color: #c92a2a; background: rgba(201,42,42,.08); }
      .dsh-cpm-gpu-usage { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) minmax(180px, 1.35fr); gap: 48px; margin-bottom: 14px; align-items: start; }
      .dsh-cpm-gpu-usage .dsh-cpm-bar { height: 8px; margin: 0; }
      .dsh-cpm-gpu-label { display: block; margin-bottom: 6px; color: #4e5969; font-size: 13px; }
      .dsh-cpm-gpu-usage .dsh-cpm-usage-cell { min-width: 0; }
      .dsh-cpm-gpu-usage .dsh-cpm-usage-cell span { white-space: nowrap; }
      .dsh-cpm-gpu-meta { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) minmax(180px, 1.35fr); gap: 8px 48px; margin: 0 0 12px; padding: 10px 0; border-radius: 10px; background: #fafafa; }
      .dsh-cpm-gpu-meta div { display: grid; grid-template-columns: 72px 1fr; gap: 6px; font-size: 12px; }
      .dsh-cpm-gpu-meta dt { margin: 0; color: #86909c; }
      .dsh-cpm-gpu-meta dd { margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .dsh-cpm-back { border: 0; background: transparent; color: #528eff; font: inherit; cursor: pointer; }
      .dsh-cpm-dialog-foot { display: flex; flex-direction: column; align-items: stretch; gap: 8px; padding: 12px 18px 16px; }
      .dsh-cpm-dialog-actions { display: flex; justify-content: flex-end; gap: 8px; }
      .dsh-cpm-upload-foot { flex-direction: row; align-items: center; justify-content: flex-end; }
      .dsh-cpm-pick { box-sizing: border-box; width: 100%; min-height: 128px; border: 1px dashed #c9cdd4; border-radius: 12px; background: #f7f8fa; color: #4e5969; font: inherit; font-size: 13px; cursor: pointer; }
      .dsh-cpm-pick:disabled { cursor: default; opacity: .6; }
      .dsh-cpm-upload-progress { display: flex; align-items: center; gap: 8px; margin-right: auto; color: #4e5969; font-size: 12px; }
      .dsh-cpm-upload-bar { width: 140px; height: 6px; border-radius: 99px; background: #f2f3f5; overflow: hidden; }
      .dsh-cpm-upload-bar i { display: block; height: 100%; background: #528eff; }
      .dsh-cpm-upload-list { display: grid; gap: 6px; margin: 12px 0 0; color: #4e5969; font-size: 13px; }
      .dsh-cpm-test-msg { margin: 0; font-size: 12px; line-height: 18px; color: #00b42a; }
      .dsh-cpm-error { margin: 0; color: #f53f3f; font-size: 12px; }
      .dsh-cpm-empty { padding: 48px 16px; text-align: center; color: #86909c; }
      .dsh-cpm-config { display: grid; gap: 12px; padding: 16px; }
      .dsh-cpm-config h2 { margin: 0; font-size: 16px; }
      .dsh-cpm-config-grid { display: grid; grid-template-columns: 1fr 140px; gap: 12px; }
      .dsh-cpm-check { display: flex; align-items: center; gap: 8px; height: 32px; }
      .dsh-cpm-crumb { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-bottom: 12px; color: #86909c; font-size: 13px; }
      .dsh-cpm-crumb button { border: 0; background: transparent; color: #528eff; font: inherit; cursor: pointer; padding: 0; }
      .dsh-cpm-file-board { display: flex; flex-direction: column; height: 100%; min-height: 0; margin-top: 20px; }
      .dsh-cpm-file-layout { display: flex; align-items: stretch; flex: 1; min-height: 0; gap: 16px; }
      .dsh-cpm-files { flex: 1; min-width: 0; min-height: 0; overflow: auto; display: grid; grid-template-columns: repeat(auto-fill, minmax(168px, 1fr)); gap: 12px; align-content: start; }
      .dsh-cpm-file { display: flex; align-items: center; gap: 10px; padding: 12px; border: 0.5px solid #e5e6eb; border-radius: 12px; background: #fff; text-align: left; cursor: pointer; font: inherit; color: inherit; }
      .dsh-cpm-file:hover, .dsh-cpm-file[data-active='true'] { border-color: #528eff; }
      .dsh-cpm-file-copy { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
      .dsh-cpm-file strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .dsh-cpm-file-copy span { color: #86909c; font-size: 12px; }
      .dsh-cpm-file-mark { flex: none; width: 36px; height: 36px; border-radius: 8px; display: grid; place-items: center; }
      .dsh-cpm-file-mark[data-kind='folder'] { background: #fff7e8; color: #f5b942; }
      .dsh-cpm-file-mark[data-kind='image'] { background: #e8f3ff; color: #528eff; }
      .dsh-cpm-file-mark[data-kind='video'] { background: #fff3e8; color: #f77234; }
      .dsh-cpm-file-mark[data-kind='audio'] { background: #f5e8ff; color: #9b51e0; }
      .dsh-cpm-file-mark[data-kind='archive'] { background: #fff7e8; color: #d48806; }
      .dsh-cpm-file-mark[data-kind='text'] { background: #f2f3f5; color: #4e5969; }
      .dsh-cpm-file-mark[data-kind='code'] { background: #e8fffb; color: #0f766e; }
      .dsh-cpm-file-mark[data-kind='pdf'] { background: #ffece8; color: #f53f3f; }
      .dsh-cpm-file-mark[data-kind='word'] { background: #e8f3ff; color: #2f6bff; }
      .dsh-cpm-file-mark[data-kind='sheet'] { background: #e8ffea; color: #00b42a; }
      .dsh-cpm-file-mark[data-kind='slide'] { background: #fff3e8; color: #f77234; }
      .dsh-cpm-file-mark[data-kind='blank'] { background: #f2f3f5; color: #86909c; }
      .dsh-cpm-folder-mark { width: 42px; height: 34px; }
      .dsh-cpm-thumb { display: block; width: 100%; height: 96px; object-fit: cover; border-radius: 8px; background: #f7f8fa; }
      .dsh-cpm-side { flex: 0 0 300px; align-self: stretch; display: flex; flex-direction: column; gap: 12px; width: 300px; min-height: 0; padding: 16px; overflow: auto; border: 0.5px solid #e5e6eb; border-radius: 12px; background: #fff; }
      .dsh-cpm-side h3 { margin: 0; font-size: 16px; word-break: break-all; }
      .dsh-cpm-preview-dialog { position: fixed; box-sizing: border-box; margin: 0; padding: 16px; overflow: hidden; }
      .dsh-cpm-preview-dialog .dsh-cpm-detail-head { margin-bottom: 8px; cursor: grab; }
      .dsh-cpm-preview-dialog .dsh-cpm-detail-head:active { cursor: grabbing; }
      .dsh-cpm-edge { position: absolute; z-index: 2; background: transparent; }
      .dsh-cpm-edge.n, .dsh-cpm-edge.s { left: 12px; right: 12px; height: 8px; cursor: ns-resize; }
      .dsh-cpm-edge.n { top: 0; }
      .dsh-cpm-edge.s { bottom: 0; }
      .dsh-cpm-edge.e, .dsh-cpm-edge.w { top: 12px; bottom: 12px; width: 8px; cursor: ew-resize; }
      .dsh-cpm-edge.w { left: 0; }
      .dsh-cpm-edge.e { right: 0; }
      .dsh-cpm-edge.nw, .dsh-cpm-edge.ne, .dsh-cpm-edge.sw, .dsh-cpm-edge.se { width: 14px; height: 14px; }
      .dsh-cpm-edge.nw { top: 0; left: 0; cursor: nwse-resize; }
      .dsh-cpm-edge.se { right: 0; bottom: 0; cursor: nwse-resize; }
      .dsh-cpm-edge.ne { top: 0; right: 0; cursor: nesw-resize; }
      .dsh-cpm-edge.sw { left: 0; bottom: 0; cursor: nesw-resize; }
      .dsh-cpm-preview-meta { margin: 0 0 12px; color: #4e5969; font-size: 13px; }
      .dsh-cpm-preview-dialog .dsh-cpm-detail-head h3 { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .dsh-cpm-preview { display: grid; place-items: center; flex: 1; min-height: 0; overflow: auto; border-radius: 8px; background: #f7f8fa; }
      .dsh-cpm-preview img, .dsh-cpm-preview video { max-width: 100%; max-height: 100%; }
      .dsh-cpm-preview iframe { width: 100%; height: 100%; border: 0; background: #fff; }
      .dsh-cpm-preview pre { box-sizing: border-box; width: 100%; margin: 0; padding: 16px; white-space: pre-wrap; word-break: break-word; text-align: left; font: 13px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace; }
      .dsh-cpm-preview p { margin: 0; color: #86909c; }
      .dsh-cpm-doc { box-sizing: border-box; width: 100%; padding: 16px 20px; text-align: left; }
      .dsh-cpm-doc p { margin: 0 0 10px; color: #1d2129; line-height: 1.7; }
      .dsh-cpm-sheet { width: 100%; border-collapse: collapse; background: #fff; font-size: 12px; }
      .dsh-cpm-sheet td { padding: 6px 8px; border: 1px solid #e5e6eb; white-space: nowrap; }
    `

    function call(_ctx, body, keyword, timeoutMs) {
      const url = keyword ? `${API_URL}?keyword=${encodeURIComponent(keyword)}` : API_URL
      const controller = new AbortController()
      const timer = timeoutMs === undefined ? null : setTimeout(() => { controller.abort() }, timeoutMs)
      return fetch(url, {
        method: body === undefined ? 'GET' : 'POST',
        credentials: 'same-origin',
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        ...(timer === null ? {} : { signal: controller.signal }),
      }).then(async response => {
        const data = await response.json().catch(() => null)
        if (!response.ok || data === null) throw new Error(data && data.message ? data.message : '请求失败')
        return data
      }).catch(error => {
        if (controller.signal.aborted) throw new Error('请求超时：服务端长时间没有响应')
        throw error
      }).finally(() => {
        if (timer !== null) clearTimeout(timer)
      })
    }

    function RoundMenu(props) {
      const { value, options, onChange, up } = props
      const [open, setOpen] = useState(false)
      const ref = useRef(null)
      useEffect(() => {
        if (!open) return undefined
        const close = event => {
          if (ref.current !== null && ref.current.contains(event.target)) return
          setOpen(false)
        }
        document.addEventListener('mousedown', close)
        return () => { document.removeEventListener('mousedown', close) }
      }, [open])
      const current = options.find(option => option.id === value)
      return h('div', { className: props.className ? `dsh-cpm-size ${props.className}` : 'dsh-cpm-size', ref },
        h('button', { type: 'button', className: 'dsh-cpm-size-btn', 'data-invalid': props.invalid ? 'true' : 'false', onClick: () => { setOpen(v => !v) } }, current ? current.label : '请选择'),
        open ? h('div', { className: up ? 'dsh-cpm-menu' : 'dsh-cpm-menu down' }, options.map(option => h('button', {
          key: option.id, type: 'button', 'data-active': option.id === value ? 'true' : 'false',
          onClick: () => { onChange(option.id); setOpen(false) },
        }, option.label))) : null)
    }

    function fileGroup(item) {
      const type = String(item.contentType || '')
      const name = String(item.name || '').toLowerCase()
      if (type.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|svg)$/.test(name)) return 'image'
      if (type.startsWith('video/') || /\.(mp4|webm|mov|mkv|avi)$/.test(name)) return 'video'
      if (type.includes('pdf') || type.startsWith('text/') || /\.(pdf|docx?|xlsx?|pptx?|txt|csv|md|json)$/.test(name)) return 'doc'
      return 'other'
    }

    function fileSize(value) {
      const size = Number(value) || 0
      if (size < 1024) return `${size} B`
      if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
      return `${(size / 1024 / 1024).toFixed(1)} MB`
    }

    function fileTypeLabel(item) {
      const name = String(item.name || '')
      const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toUpperCase() : ''
      if (ext !== '') return ext
      const type = String(item.contentType || '')
      const sub = type.includes('/') ? type.slice(type.indexOf('/') + 1) : type
      return sub === '' ? '文件' : sub.toUpperCase()
    }

    function FileThumb(props) {
      const { id } = props
      const [url, setUrl] = useState('')
      useEffect(() => {
        let active = true
        let objectUrl = ''
        fetch(`${API_URL}?fileId=${encodeURIComponent(id)}`, { credentials: 'same-origin' }).then(response => {
          if (!response.ok) throw new Error('preview')
          return response.blob()
        }).then(blob => {
          if (!active) return
          objectUrl = URL.createObjectURL(blob)
          setUrl(objectUrl)
        }).catch(() => { if (active) setUrl('') })
        return () => { active = false; if (objectUrl !== '') URL.revokeObjectURL(objectUrl) }
      }, [id])
      return url === '' ? h('span', { className: 'dsh-cpm-thumb' }) : h('img', { className: 'dsh-cpm-thumb', src: url, alt: '' })
    }

    function previewKind(item) {
      const name = String(item.name || '').toLowerCase()
      const type = String(item.contentType || '')
      if (fileGroup(item) === 'image') return 'image'
      if (fileGroup(item) === 'video') return 'video'
      if (name.endsWith('.pdf') || type === 'application/pdf') return 'pdf'
      if (/\.(txt|md|log|json)$/.test(name) || type.startsWith('text/plain')) return 'text'
      if (/\.(csv|tsv|xlsx)$/.test(name)) return 'sheet'
      if (name.endsWith('.docx')) return 'doc'
      if (name.endsWith('.pptx')) return 'ppt'
      return 'none'
    }

    async function readZip(buffer) {
      const bytes = new Uint8Array(buffer)
      const view = new DataView(buffer)
      let eocd = -1
      for (let index = bytes.length - 22; index >= Math.max(0, bytes.length - 70000); index -= 1) {
        if (view.getUint32(index, true) === 0x06054b50) { eocd = index; break }
      }
      if (eocd < 0) throw new Error('zip')
      const count = view.getUint16(eocd + 10, true)
      let cursor = view.getUint32(eocd + 16, true)
      const files = {}
      for (let index = 0; index < count; index += 1) {
        if (view.getUint32(cursor, true) !== 0x02014b50) break
        const method = view.getUint16(cursor + 10, true)
        const size = view.getUint32(cursor + 20, true)
        const nameLen = view.getUint16(cursor + 28, true)
        const extraLen = view.getUint16(cursor + 30, true)
        const commentLen = view.getUint16(cursor + 32, true)
        const local = view.getUint32(cursor + 42, true)
        const name = new TextDecoder().decode(bytes.subarray(cursor + 46, cursor + 46 + nameLen))
        const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true)
        const slice = bytes.subarray(start, start + size)
        if (method === 0) files[name] = slice
        else if (method === 8) {
          const stream = new Blob([slice]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
          files[name] = new Uint8Array(await new Response(stream).arrayBuffer())
        }
        cursor += 46 + nameLen + extraLen + commentLen
      }
      return files
    }

    function xmlPlain(value) {
      return value.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code))).trim()
    }

    function sheetTable(rows) {
      return h('table', { className: 'dsh-cpm-sheet' }, h('tbody', null, rows.map((row, index) => h('tr', { key: index }, row.map((cell, cellIndex) => h('td', { key: cellIndex }, cell || ''))))))
    }

    function FilePreview(props) {
      const { id, kind } = props
      const [view, setView] = useState(null)
      useEffect(() => {
        let active = true
        let objectUrl = ''
        const finish = (next) => { if (active) setView(next) }
        fetch(`${API_URL}?fileId=${encodeURIComponent(id)}`, { credentials: 'same-origin' }).then(response => {
          if (!response.ok) throw new Error('preview')
          return response.blob()
        }).then(async blob => {
          if (kind === 'image' || kind === 'video' || kind === 'pdf') {
            objectUrl = URL.createObjectURL(blob)
            finish({ type: kind, url: objectUrl })
            return
          }
          if (kind === 'text') {
            finish({ type: 'text', text: await blob.text() })
            return
          }
          const lowerName = String(props.name || '').toLowerCase()
          if (kind === 'sheet' && (lowerName.endsWith('.csv') || lowerName.endsWith('.tsv'))) {
            const text = await blob.text()
            const split = lowerName.endsWith('.tsv') ? '\t' : ','
            finish({ type: 'sheet', rows: text.split(/\r?\n/).filter(line => line !== '').slice(0, 200).map(line => line.split(split)) })
            return
          }
          const files = await readZip(await blob.arrayBuffer())
          if (kind === 'sheet') {
            const strings = []
            const shared = files['xl/sharedStrings.xml']
            if (shared) {
              for (const part of new TextDecoder().decode(shared).split(/<si[\s>]/).slice(1)) {
                strings.push(xmlPlain([...part.matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map(item => item[1]).join('')))
              }
            }
            const sheetName = Object.keys(files).find(name => /^xl\/worksheets\/sheet1\.xml$/.test(name))
            const rows = []
            if (sheetName) {
              for (const row of new TextDecoder().decode(files[sheetName]).split(/<row[\s>]/).slice(1)) {
                const cells = []
                let column = 0
                for (const cell of row.matchAll(/<c([^>]*)>([\s\S]*?)<\/c>/g)) {
                  const letters = ((cell[1].match(/r="([A-Z]+)/) || [])[1] || '')
                  let index = 0
                  for (const char of letters) index = index * 26 + char.charCodeAt(0) - 64
                  index -= 1
                  while (column < index) { cells.push(''); column += 1 }
                  const cellType = (cell[1].match(/t="([^"]+)"/) || [])[1]
                  const value = (cell[2].match(/<v>([^<]*)<\/v>/) || [])[1] || ''
                  cells.push(cellType === 's' ? (strings[Number(value)] || '') : xmlPlain(value))
                  column += 1
                }
                if (cells.length > 0) rows.push(cells)
              }
            }
            finish({ type: 'sheet', rows: rows.slice(0, 200) })
            return
          }
          if (kind === 'doc') {
            const xml = new TextDecoder().decode(files['word/document.xml'] || new Uint8Array())
            const paragraphs = xml.split(/<w:p[\s>]/).slice(1).map(part => xmlPlain(part.split('</w:p>')[0])).filter(line => line !== '')
            finish({ type: 'doc', paragraphs })
            return
          }
          const slides = Object.keys(files).filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name)).sort((left, right) => Number(left.match(/\d+/)[0]) - Number(right.match(/\d+/)[0]))
          finish({ type: 'ppt', slides: slides.map(name => xmlPlain(new TextDecoder().decode(files[name]))).filter(line => line !== '') })
        }).catch(() => { finish({ type: 'error' }) })
        return () => { active = false; if (objectUrl !== '') URL.revokeObjectURL(objectUrl) }
      }, [id, kind])
      if (kind === 'none') return h('p', null, '暂不支持预览')
      if (view === null) return h('p', null, '正在加载预览…')
      if (view.type === 'error') return h('p', null, '暂不支持预览')
      if (view.type === 'image') return h('img', { src: view.url, alt: '' })
      if (view.type === 'video') return h('video', { src: view.url, controls: true })
      if (view.type === 'pdf') return h('iframe', { src: view.url, title: 'PDF 预览' })
      if (view.type === 'text') return h('pre', null, view.text || '空文件')
      if (view.type === 'sheet') return view.rows.length === 0 ? h('p', null, '表格是空的') : sheetTable(view.rows)
      if (view.type === 'doc') return h('div', { className: 'dsh-cpm-doc' }, view.paragraphs.length === 0 ? h('p', null, '文档没有可显示的文字') : view.paragraphs.map((line, index) => h('p', { key: index }, line)))
      return h('div', { className: 'dsh-cpm-doc' }, view.slides.length === 0 ? h('p', null, '演示文稿没有可显示的文字') : view.slides.map((line, index) => h('p', { key: index }, `第 ${index + 1} 页　${line}`)))
    }

    function pct(value) {
      return typeof value === 'number' && !Number.isNaN(value) ? `${value.toFixed(1)}%` : '—'
    }

    function CpmPage(props) {
      const { ctx } = props
      const [tab, setTab] = useState('resources')
      const [files, setFiles] = useState([])
      const [fileParent, setFileParent] = useState('')
      const [fileOpen, setFileOpen] = useState(null)
      const [previewBox, setPreviewBox] = useState(null)
      const [fileView, setFileView] = useState('all')
      const [fileType, setFileType] = useState('all')
      const [filePage, setFilePage] = useState(1)
      const [filePageSize, setFilePageSize] = useState(100)
      const [folderOpen, setFolderOpen] = useState(false)
      const [folderName, setFolderName] = useState('')
      const [uploadOpen, setUploadOpen] = useState(false)
      const [uploadList, setUploadList] = useState([])
      const [uploadProgress, setUploadProgress] = useState(null)
      const fileInput = useRef(null)
      const [resources, setResources] = useState([])
      const [containers, setContainers] = useState([])
      const [registryImages, setRegistryImages] = useState([])
      const [registryError, setRegistryError] = useState('')
      const [metrics, setMetrics] = useState({})
      const [keyword, setKeyword] = useState('')
      const [query, setQuery] = useState('')
      const [page, setPage] = useState(1)
      const [pageSize, setPageSize] = useState(12)
      const [status, setStatus] = useState('loading')
      const [error, setError] = useState('')
      const [dialog, setDialog] = useState(null)
      const [draft, setDraft] = useState(null)
      const [saving, setSaving] = useState(false)
      const [testing, setTesting] = useState(false)
      const [testMessage, setTestMessage] = useState('')
      const [testedKey, setTestedKey] = useState('')
      const [invalid, setInvalid] = useState({})
      const [screen, setScreen] = useState('list')
      const [focus, setFocus] = useState(null)
      const [instances, setInstances] = useState([])
      const [instanceError, setInstanceError] = useState('')
      const [instancesLoading, setInstancesLoading] = useState(false)
      const [termSize, setTermSize] = useState({ w: Math.min(1480, Math.max(1080, window.innerWidth - 48)), h: Math.min(860, Math.max(680, window.innerHeight - 48)) })
      const [debugPane, setDebugPane] = useState(420)
      const [termPos, setTermPos] = useState(null)
      const [instKeyword, setInstKeyword] = useState('')
      const [instState, setInstState] = useState('')
      const [instImage, setInstImage] = useState('')
      const [instSort, setInstSort] = useState('name')
      const [instDir, setInstDir] = useState('asc')
      const [selectedIds, setSelectedIds] = useState([])
      const [batchOpen, setBatchOpen] = useState(false)
      const [logsTarget, setLogsTarget] = useState(null)
      const [logsText, setLogsText] = useState('')
      const [logsTail, setLogsTail] = useState(100)
      const [debugTarget, setDebugTarget] = useState(null)
      const [debugView, setDebugView] = useState({ rows: ['正在连接…'], row: 0, col: 0 })
      const [debugTree, setDebugTree] = useState({})
      const [debugOpenDirs, setDebugOpenDirs] = useState({ '/': true })
      const [debugDirError, setDebugDirError] = useState('')
      const [debugDrop, setDebugDrop] = useState('')
      const [debugSelected, setDebugSelected] = useState('')
      const [debugClip, setDebugClip] = useState(null)
      const [debugMenu, setDebugMenu] = useState(null)
      const [debugTasks, setDebugTasks] = useState([])
      const [debugTaskId, setDebugTaskId] = useState('')
      const [debugClock, setDebugClock] = useState(0)
      const debugStops = useRef({})
      const debugSeq = useRef(0)
      const debugFiles = useRef(null)
      const debugSocket = useRef(null)
      const debugWaits = useRef({})
      const debugReady = useRef(Promise.resolve())
      const termBody = useRef(null)
      useEffect(() => {
        if (!debugTarget) return
        termBody.current?.focus()
        setDebugTree({})
        setDebugOpenDirs({ '/': true })
        setDebugDirError('')
        void loadDebugDir('/')
      }, [debugTarget])
      useEffect(() => {
        if (termBody.current) termBody.current.scrollTop = termBody.current.scrollHeight
      }, [debugView])
      const [deployLog, setDeployLog] = useState('')

      const load = async () => {
        setStatus('loading')
        setError('')
        try {
          const data = await call(ctx, undefined, query)
          setResources(Array.isArray(data.resources) ? data.resources : [])
          setContainers(Array.isArray(data.containers) ? data.containers : [])
          setRegistryImages(Array.isArray(data.registryImages) ? data.registryImages : [])
          setRegistryError(typeof data.registryError === 'string' ? data.registryError : '')
          setStatus('ready')
        } catch (reason) {
          setStatus('error')
          setError(reason.message || '加载失败')
        }
      }

      const loadFiles = async () => {
        const data = await call(ctx, { action: 'list-files' })
        setFiles(Array.isArray(data.files) ? data.files : [])
      }

      useEffect(() => { void load() }, [query])
      useEffect(() => { if (tab === 'files') void loadFiles().catch(reason => { setError(reason.message || '文件仓库加载失败') }) }, [tab])

      useEffect(() => {
        if (resources.length === 0) { setMetrics({}); return undefined }
        let stop = false
        const pull = async () => {
          const next = {}
          await Promise.all(resources.map(async resource => {
            try {
              const data = await call(ctx, { action: 'resource-metrics', id: resource.id })
              next[resource.id] = data.metrics
            } catch (_failure) { next[resource.id] = null }
          }))
          if (!stop) setMetrics(next)
        }
        void pull()
        const timer = setInterval(() => { void pull() }, 3000)
        return () => { stop = true; clearInterval(timer) }
      }, [resources])

      const catalog = (() => {
        const saved = containers.map(item => ({ ...item, reference: item.imageSource === 'file' ? (item.imageFileName || '') : (item.imageRef || '') }))
        const known = new Set(saved.map(item => item.imageRef).filter(Boolean))
        const extras = []
        for (const image of registryImages) {
          const tags = image.tags && image.tags.length ? image.tags : ['latest']
          for (const tag of tags) {
            const ref = `${image.reference}:${tag}`
            if (known.has(ref)) continue
            extras.push({
              id: '', name: image.name, architecture: 'X86', accelerator: 'CPU', imageVersion: tag,
              composeYaml: '', imageRef: ref, imageSource: 'registry', imageFileName: '', icon: '', remark: '',
              reference: ref, tags: [tag], registryOnly: true,
            })
          }
        }
        return [...saved, ...extras]
      })()
      const list = tab === 'containers' ? catalog : resources
      const pages = Math.max(1, Math.ceil(list.length / pageSize))
      const current = Math.min(page, pages)
      const visible = list.slice((current - 1) * pageSize, current * pageSize)
      const counts = resources.reduce((sum, item) => {
        if (item.status === '正常') sum.normal += 1
        else if (item.status === '异常') sum.error += 1
        else sum.starting += 1
        return sum
      }, { normal: 0, error: 0, starting: 0 })
      const average = (key) => {
        const values = resources.map(item => {
          const live = metrics[item.id]
          if (!live) return null
          if (key === 'cpu') return live.cpu && live.cpu.usage_percent
          if (key === 'mem') return live.memory && live.memory.used_percent
          return diskPct(live)
        }).filter(value => typeof value === 'number')
        if (values.length === 0) return null
        return values.reduce((sum, value) => sum + value, 0) / values.length
      }
      const archCounts = resources.reduce((sum, item) => {
        const name = item.architecture || '未填架构'
        sum[name] = (sum[name] || 0) + 1
        return sum
      }, {})

      const openResource = (item) => {
        setDraft({
          id: item ? item.id : '',
          name: item ? item.name : '',
          architecture: item ? item.architecture : '',
          cardTypes: item && item.cardTypes ? item.cardTypes : [],
          nodeIp: item ? item.nodeIp : '',
          sshPort: item ? String(item.sshPort || 22) : '22',
          imageRef: item ? item.imageRef || '' : '',
          username: item ? item.username || '' : '',
          password: item ? item.password || '' : '',
          authMode: item ? item.authMode || 'password' : 'password',
          privateKey: item ? item.privateKey || '' : '',
          icon: item && typeof item.icon === 'string' && item.icon.startsWith('data:image/') ? item.icon : '',
          remark: item ? item.remark || '' : '',
          status: item ? item.status || '启动中' : '启动中',
        })
        setTestMessage('')
        setTestedKey('')
        setInvalid({})
        setDialog(item ? 'edit-resource' : 'create-resource')
      }
      const openContainer = (item) => {
        const saved = item && item.id && !item.registryOnly
        setDraft({
          id: saved ? item.id : '',
          name: item ? item.name : '',
          architecture: item ? item.architecture || '' : '',
          accelerator: item ? item.accelerator || '' : '',
          imageVersion: item ? item.imageVersion || '' : '',
          imageRef: item ? item.imageRef || '' : '',
          imageSource: item ? item.imageSource || 'registry' : 'registry',
          imageFileName: item ? item.imageFileName || '' : '',
          icon: item && typeof item.icon === 'string' && item.icon.startsWith('data:image/') ? item.icon : '',
          composeYaml: item ? item.composeYaml || '' : '',
          remark: item ? item.remark || '' : '',
        })
        setInvalid({})
        setDialog(saved ? 'edit-container' : 'create-container')
      }
      const openDeploy = (item) => {
        if (!item.id) { window.alert('请先保存这张镜像，再部署'); return }
        const image = item.imageRef || ''
        const fallback = image ? `services:\n  app:\n    image: ${image}\n    restart: unless-stopped\n` : ''
        setDraft({
          id: item.id,
          name: item.name || '',
          architecture: item.architecture || '',
          composeYaml: item.composeYaml && item.composeYaml.trim() ? item.composeYaml : fallback,
          resourceId: '',
        })
        setDeployLog('')
        setError('')
        setDialog('deploy')
      }

      const connectionKey = (value) => [value.nodeIp, value.sshPort, value.username, value.authMode, value.authMode === 'password' ? value.password : '', value.authMode === 'certificate' ? value.privateKey : ''].join('\0')
      const resourceGaps = (value) => {
        const gaps = {}
        if (!value.name.trim()) gaps.name = true
        if (!value.architecture) gaps.architecture = true
        if (!value.cardTypes.length) gaps.card = true
        if (!value.nodeIp.trim()) gaps.nodeIp = true
        if (String(value.sshPort).trim() === '') gaps.sshPort = true
        if (!value.username.trim()) gaps.username = true
        if (value.authMode === 'certificate' ? !value.privateKey.trim() : !value.password) gaps.secret = true
        if (!value.icon) gaps.icon = true
        if (!value.imageRef) gaps.imageRef = true
        return gaps
      }
      const save = async () => {
        if (dialog === 'create-resource' || dialog === 'edit-resource') {
          const gaps = resourceGaps(draft)
          if (Object.keys(gaps).length > 0) { setInvalid(gaps); return }
        }
        if (dialog === 'create-container' || dialog === 'edit-container') {
          const gaps = {}
          if (!draft.name.trim()) gaps.name = true
          if (!draft.architecture) gaps.architecture = true
          if (!draft.accelerator) gaps.accelerator = true
          if (!draft.imageVersion.trim()) gaps.imageVersion = true
          if (!draft.composeYaml.trim()) gaps.composeYaml = true
          if (draft.imageSource === 'file' ? !draft.imageFileName : !draft.imageRef.trim()) gaps.imageOrigin = true
          if (Object.keys(gaps).length > 0) { setInvalid(gaps); return }
        }
        if ((dialog === 'create-resource' || dialog === 'edit-resource') && testedKey !== connectionKey(draft)) {
          setError('请先测试连接')
          setTestMessage('请先测试连接')
          return
        }
        setSaving(true)
        setError('')
        try {
          if (dialog === 'create-resource' || dialog === 'edit-resource') {
            const body = {
              name: draft.name.trim(),
              architecture: draft.architecture,
              cardTypes: draft.cardTypes,
              nodeIp: draft.nodeIp.trim(),
              sshPort: Number(draft.sshPort),
              username: draft.username.trim(),
              password: draft.authMode === 'password' ? draft.password : '',
              authMode: draft.authMode,
              privateKey: draft.authMode === 'certificate' ? draft.privateKey : '',
              icon: draft.icon,
              imageRef: draft.imageRef,
              remark: draft.remark,
            }
            if (dialog === 'create-resource') await call(ctx, { action: 'create-resource', ...body })
            else await call(ctx, { action: 'update-resource', id: draft.id, ...body, status: draft.status || '启动中' })
          } else if (dialog === 'deploy') {
            if (!draft.resourceId) { setError('请选择算力资源'); return }
            if (!draft.composeYaml.trim()) { setError('请填写 Docker 编排'); return }
            setDeployLog('')
            const result = await call(ctx, { action: 'deploy', containerId: draft.id, resourceId: draft.resourceId, composeYaml: draft.composeYaml })
            setDeployLog(result.log || (result.ok ? '部署完成' : '部署失败'))
            setError(result.ok ? '' : '部署失败，请查看右侧日志')
            return
          } else {
            const body = {
              name: draft.name.trim(),
              architecture: draft.architecture,
              accelerator: draft.accelerator,
              imageVersion: draft.imageVersion.trim(),
              imageRef: draft.imageSource === 'registry' ? draft.imageRef.trim() : '',
              imageSource: draft.imageSource,
              imageFileName: draft.imageSource === 'file' ? draft.imageFileName : '',
              icon: draft.icon || '',
              composeYaml: draft.composeYaml,
              remark: draft.remark,
            }
            if (dialog === 'create-container') await call(ctx, { action: 'create-container', ...body })
            else await call(ctx, { action: 'update-container', id: draft.id, ...body })
          }
          setDialog(null)
          await load()
        } catch (reason) {
          setError(reason.message || '保存失败')
        } finally { setSaving(false) }
      }

      const testConnection = async () => {
        setTesting(true)
        setTestMessage('')
        setError('')
        try {
          await call(ctx, {
            action: 'test-connection',
            name: draft.name.trim() || '测试',
            architecture: draft.architecture,
            cardTypes: draft.cardTypes,
            nodeIp: draft.nodeIp.trim(),
            sshPort: Number(draft.sshPort),
            username: draft.username.trim(),
            password: draft.authMode === 'password' ? draft.password : '',
            authMode: draft.authMode,
            privateKey: draft.authMode === 'certificate' ? draft.privateKey : '',
            icon: draft.icon,
            remark: draft.remark,
          })
          setTestMessage('连接正常')
          setTestedKey(connectionKey(draft))
        } catch (reason) {
          setTestedKey('')
          setTestMessage(reason.message || '连接失败')
        } finally { setTesting(false) }
      }

      const remove = async (kind, item) => {
        if (!window.confirm(`确定删除「${item.name}」吗？`)) return
        try {
          await call(ctx, { action: kind === 'resource' ? 'delete-resource' : 'delete-container', id: item.id })
          await load()
        } catch (reason) { setError(reason.message || '删除失败') }
      }

      const clearInvalid = (key) => { setInvalid(current => ({ ...current, [key]: false })) }
      const field = (key, label, type) => h('label', { className: 'dsh-cpm-field' }, h('span', null, label),
        h('input', { className: 'dsh-cpm-input', type, 'data-invalid': invalid[key] ? 'true' : 'false', value: draft[key], onChange: event => { clearInvalid(key); setDraft({ ...draft, [key]: event.target.value }) } }))
      const imageOptions = registryImages.flatMap(image => {
        const tags = image.tags && image.tags.length ? image.tags : ['']
        return tags.map(tag => {
          const ref = tag ? `${image.reference}:${tag}` : image.reference
          return { id: ref, label: ref }
        })
      })
      const menuField = (key, label, options) => h('div', { className: 'dsh-cpm-field' }, h('span', null, label),
        h(RoundMenu, { value: draft[key], options: options.map(id => ({ id, label: id })), onChange: id => { setDraft({ ...draft, [key]: id }) } }))

      const dialogNode = dialog === null || draft === null ? null : h('div', { className: 'dsh-cpm-overlay', onMouseDown: event => { if (event.target === event.currentTarget && !saving) setDialog(null) } },
        h('form', { className: dialog === 'deploy' ? 'dsh-cpm-dialog wide' : 'dsh-cpm-dialog', onSubmit: event => { event.preventDefault(); void save() } },
          h('h2', null, dialog.includes('resource') ? (draft.id ? '编辑算力资源' : '添加算力资源') : dialog === 'deploy' ? `部署镜像 · ${draft.name || ''}` : (draft.id ? '编辑镜像' : '新建镜像'),
            h('button', { type: 'button', className: 'dsh-cpm-icon', onClick: () => { setDialog(null) } }, '×')),
          h('div', { className: 'dsh-cpm-body' },
            dialog === 'deploy'
              ? h('div', { className: 'dsh-cpm-deploy' },
                h('div', null,
                  h('div', { className: 'dsh-cpm-field' }, h('span', null, '算力资源'),
                    h(RoundMenu, {
                      value: draft.resourceId || '',
                      options: resources.filter(item => !draft.architecture || item.architecture === draft.architecture).map(item => ({ id: item.id, label: `${item.name}（${item.nodeIp}）` })),
                      onChange: id => { setDraft({ ...draft, resourceId: id }) },
                    })),
                  h('label', { className: 'dsh-cpm-field' }, h('span', null, 'Docker 编排'),
                    h('textarea', { className: 'dsh-cpm-area', value: draft.composeYaml || '', spellCheck: false, placeholder: 'docker-compose YAML', onChange: event => { setDraft({ ...draft, composeYaml: event.target.value }) } }))),
                h('div', null,
                  h('div', { className: 'dsh-cpm-field' }, h('span', null, '运行日志')),
                  h('pre', { className: 'dsh-cpm-log' }, deployLog || '部署后日志将显示在这里')))
              : dialog.includes('resource')
                ? h(React.Fragment, null,
                  field('name', '名称'),
                  h('div', { className: 'dsh-cpm-field' }, h('span', null, '架构'),
                    h('div', { className: 'dsh-cpm-choices', 'data-invalid': invalid.architecture ? 'true' : 'false' }, RESOURCE_ARCHS.map(arch => h('button', {
                      key: arch, type: 'button', className: 'dsh-cpm-choice', 'data-active': draft.architecture === arch ? 'true' : 'false',
                      onClick: () => { clearInvalid('architecture'); setDraft({ ...draft, architecture: arch }) },
                    }, arch)))),
                  h('div', { className: 'dsh-cpm-field' }, h('span', null, '计算卡'),
                    h('div', { className: 'dsh-cpm-choices', 'data-invalid': invalid.card ? 'true' : 'false' }, CARDS.map(card => h('button', {
                      key: card, type: 'button', className: 'dsh-cpm-choice', 'data-active': draft.cardTypes[0] === card ? 'true' : 'false',
                      onClick: () => { clearInvalid('card'); setDraft({ ...draft, cardTypes: [card] }) },
                    }, card)))),
                  h('div', { className: 'dsh-cpm-field' }, h('span', null, '数传镜像'),
                    h(RoundMenu, { value: draft.imageRef, invalid: invalid.imageRef, options: imageOptions, onChange: id => { clearInvalid('imageRef'); setDraft({ ...draft, imageRef: id }) } })),
                  field('nodeIp', '节点 IP'),
                  field('sshPort', 'SSH 端口'),
                  h('div', { className: 'dsh-cpm-field' }, h('span', null, '登录方式'),
                    h('div', { className: 'dsh-cpm-choices' },
                      h('button', { type: 'button', className: 'dsh-cpm-choice', 'data-active': draft.authMode === 'password' ? 'true' : 'false', onClick: () => { setDraft({ ...draft, authMode: 'password' }) } }, '密码'),
                      h('button', { type: 'button', className: 'dsh-cpm-choice', 'data-active': draft.authMode === 'certificate' ? 'true' : 'false', onClick: () => { setDraft({ ...draft, authMode: 'certificate' }) } }, '证书'))),
                  field('username', '账号'),
                  draft.authMode === 'certificate'
                    ? h('label', { className: 'dsh-cpm-field' }, h('span', null, '证书'),
                      h('textarea', { className: 'dsh-cpm-area', 'data-invalid': invalid.secret ? 'true' : 'false', value: draft.privateKey, placeholder: '粘贴私钥', onChange: event => { clearInvalid('secret'); setDraft({ ...draft, privateKey: event.target.value }) } }))
                    : h('label', { className: 'dsh-cpm-field' }, h('span', null, '密码'),
                      h('input', { className: 'dsh-cpm-input', type: 'password', 'data-invalid': invalid.secret ? 'true' : 'false', value: draft.password, autoComplete: 'new-password', onChange: event => { clearInvalid('secret'); setDraft({ ...draft, password: event.target.value }) } })),
                  h('div', { className: 'dsh-cpm-field' }, h('span', null, '图标'),
                    h('div', { className: 'dsh-cpm-upload' },
                      h('label', { className: 'dsh-cpm-upload-btn', 'data-invalid': invalid.icon ? 'true' : 'false' },
                        draft.icon ? h('img', { src: draft.icon, alt: '' }) : '上传图片',
                        h('input', { type: 'file', accept: 'image/*', hidden: true, onChange: event => {
                          const file = event.target.files && event.target.files[0]
                          event.target.value = ''
                          if (!file) return
                          if (!file.type.startsWith('image/')) { setError('请上传图片文件'); return }
                          if (file.size > 1024 * 1024) { setError('图片不能超过 1MB'); return }
                          const reader = new FileReader()
                          reader.onload = () => { setDraft({ ...draft, icon: String(reader.result || '') }); setError('') }
                          reader.readAsDataURL(file)
                        } })),
                      draft.icon ? h('button', { type: 'button', className: 'dsh-cpm-btn', onClick: () => { setDraft({ ...draft, icon: '' }) } }, '移除') : null)),
                  field('remark', '备注'))
                : h(React.Fragment, null,
                  field('name', '名称'),
                  h('div', { className: 'dsh-cpm-field' }, h('span', null, '支持架构'),
                    h('div', { className: 'dsh-cpm-choices', 'data-invalid': invalid.architecture ? 'true' : 'false' }, ARCHS.map(arch => h('button', {
                      key: arch, type: 'button', className: 'dsh-cpm-choice', 'data-active': draft.architecture === arch ? 'true' : 'false',
                      onClick: () => { clearInvalid('architecture'); setDraft({ ...draft, architecture: arch }) },
                    }, arch)))),
                  h('div', { className: 'dsh-cpm-field' }, h('span', null, '支持计算卡'),
                    h('div', { className: 'dsh-cpm-choices', 'data-invalid': invalid.accelerator ? 'true' : 'false' }, ACCELS.map(card => h('button', {
                      key: card, type: 'button', className: 'dsh-cpm-choice', 'data-active': draft.accelerator === card ? 'true' : 'false',
                      onClick: () => { clearInvalid('accelerator'); setDraft({ ...draft, accelerator: card }) },
                    }, card)))),
                  field('imageVersion', '镜像版本'),
                  h('div', { className: 'dsh-cpm-field' }, h('span', null, '图标'),
                    h('div', { className: 'dsh-cpm-upload' },
                      h('label', { className: 'dsh-cpm-upload-btn' },
                        draft.icon ? h('img', { src: draft.icon, alt: '' }) : '上传图片',
                        h('input', { type: 'file', accept: 'image/*', hidden: true, onChange: event => {
                          const file = event.target.files && event.target.files[0]
                          event.target.value = ''
                          if (!file) return
                          if (!file.type.startsWith('image/')) { setError('请上传图片文件'); return }
                          if (file.size > 1024 * 1024) { setError('图片不能超过 1MB'); return }
                          const reader = new FileReader()
                          reader.onload = () => { setDraft(current => ({ ...current, icon: String(reader.result || '') })); setError('') }
                          reader.readAsDataURL(file)
                        } })),
                      draft.icon ? h('button', { type: 'button', className: 'dsh-cpm-btn', onClick: () => { setDraft({ ...draft, icon: '' }) } }, '移除') : null)),
                  h('label', { className: 'dsh-cpm-field' }, h('span', null, 'Docker 编排'),
                    h('textarea', { className: 'dsh-cpm-area', 'data-invalid': invalid.composeYaml ? 'true' : 'false', value: draft.composeYaml, placeholder: 'docker-compose YAML', onChange: event => { clearInvalid('composeYaml'); setDraft({ ...draft, composeYaml: event.target.value }) } })),
                  h('div', { className: 'dsh-cpm-field' }, h('span', null, '镜像来源'),
                    h('div', { className: 'dsh-cpm-choices', 'data-invalid': invalid.imageOrigin ? 'true' : 'false' },
                      h('button', { type: 'button', className: 'dsh-cpm-choice', 'data-active': draft.imageSource === 'file' ? 'true' : 'false', onClick: () => { setDraft({ ...draft, imageSource: 'file' }) } }, '镜像文件'),
                      h('button', { type: 'button', className: 'dsh-cpm-choice', 'data-active': draft.imageSource === 'registry' ? 'true' : 'false', onClick: () => { setDraft({ ...draft, imageSource: 'registry' }) } }, '镜像地址')),
                    draft.imageSource === 'file'
                      ? h('div', { className: 'dsh-cpm-upload' },
                        h('span', null, draft.imageFileName || '尚未选择镜像文件'),
                        h('label', { className: 'dsh-cpm-btn' }, draft.imageFileName ? '更换文件' : '选择文件',
                          h('input', { type: 'file', accept: '.tar,.tar.gz,.tgz', hidden: true, onChange: event => {
                            const file = event.target.files && event.target.files[0]
                            event.target.value = ''
                            if (!file) return
                            clearInvalid('imageOrigin')
                            setDraft(current => ({ ...current, imageFileName: file.name, imageSource: 'file' }))
                          } })))
                      : h('input', { className: 'dsh-cpm-input', 'data-invalid': invalid.imageOrigin ? 'true' : 'false', value: draft.imageRef, placeholder: '如 registry.example.com/ns/app:v1.0.0', onChange: event => { clearInvalid('imageOrigin'); setDraft({ ...draft, imageRef: event.target.value }) } })),
                  field('remark', '备注')),
            error === '' ? null : h('p', { className: 'dsh-cpm-error' }, error)),
          h('div', { className: 'dsh-cpm-dialog-foot' },
            testMessage === '' ? null : h('p', { className: testMessage === '连接正常' ? 'dsh-cpm-test-msg' : 'dsh-cpm-error' }, testMessage),
            h('div', { className: 'dsh-cpm-dialog-actions' },
              dialog.includes('resource') ? h('button', { type: 'button', className: 'dsh-cpm-btn', disabled: saving || testing, onClick: () => { void testConnection() } }, testing ? '测试中…' : '测试连接') : null,
              h('button', { type: 'button', className: 'dsh-cpm-btn', disabled: saving, onClick: () => { setDialog(null); setTestMessage('') } }, '取消'),
              h('button', { type: 'submit', className: 'dsh-cpm-btn dsh-cpm-primary', disabled: saving }, saving && dialog === 'deploy' ? '部署中…' : dialog === 'deploy' ? '部署' : '确定')))))

      const liveOf = (id) => metrics[id] || null
      const diskPct = (live) => {
        const disks = live && Array.isArray(live.disk) ? live.disk : []
        const root = disks.find(disk => disk.mountpoint === '/') || disks[0]
        return root && typeof root.used_percent === 'number' ? root.used_percent : null
      }
      const bytes = (value) => {
        if (typeof value !== 'number') return '—'
        const units = ['B', 'KB', 'MB', 'GB', 'TB']
        let size = value
        let index = 0
        while (size >= 1024 && index < units.length - 1) { size /= 1024; index += 1 }
        return `${size.toFixed(index === 0 ? 0 : 1)} ${units[index]}`
      }
      const openDetail = (item) => { setFocus(item); setScreen('detail'); setTab('resources') }
      const openInstances = async (item) => {
        setFocus(item)
        setScreen('instances')
        setTab('resources')
        setInstances([])
        setInstanceError('')
        setInstancesLoading(true)
        try {
          const data = await call(ctx, { action: 'resource-containers', id: item.id })
          setInstances(Array.isArray(data.items) ? data.items : [])
        } catch (reason) { setInstanceError(reason.message || '读取运行实例失败') }
        finally { setInstancesLoading(false) }
      }
      const dragTerm = (event) => {
        if (event.button !== 0 || event.target.closest('button')) return
        event.preventDefault()
        const node = event.currentTarget.parentElement
        const rect = node.getBoundingClientRect()
        const originX = event.clientX
        const originY = event.clientY
        const move = (ev) => {
          setTermPos({
            x: Math.min(window.innerWidth - 80, Math.max(0, rect.left + ev.clientX - originX)),
            y: Math.min(window.innerHeight - 48, Math.max(0, rect.top + ev.clientY - originY)),
          })
        }
        const up = () => {
          window.removeEventListener('pointermove', move)
          window.removeEventListener('pointerup', up)
          termBody.current?.focus()
        }
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', up)
      }
      const resizeTerm = (event) => {
        event.preventDefault()
        event.stopPropagation()
        const startX = event.clientX
        const startY = event.clientY
        const start = termSize
        const move = (ev) => {
          setTermSize({
            w: Math.max(520, Math.min(window.innerWidth - 48, start.w + ev.clientX - startX)),
            h: Math.max(360, Math.min(window.innerHeight - 48, start.h + ev.clientY - startY)),
          })
        }
        const up = () => {
          window.removeEventListener('pointermove', move)
          window.removeEventListener('pointerup', up)
        }
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', up)
      }
      const levelOf = (value) => typeof value !== 'number' ? '' : value >= 90 ? 'danger' : value >= 70 ? 'warn' : 'ok'
      const meter = (value) => h('span', { className: 'dsh-cpm-bar' }, h('i', { 'data-level': levelOf(value) || 'ok', style: { width: `${Math.min(100, Math.max(0, value || 0))}%` } }))
      const uptimeText = (sec) => {
        if (typeof sec !== 'number' || sec < 0) return '—'
        const days = Math.floor(sec / 86400)
        const hours = Math.floor((sec % 86400) / 3600)
        const minutes = Math.floor((sec % 3600) / 60)
        if (days > 0) return `${days} 天 ${hours} 小时`
        if (hours > 0) return `${hours} 小时 ${minutes} 分钟`
        return `${minutes} 分钟`
      }
      const stateLabel = (state) => ({ running: '运行中', exited: '已停止', created: '已创建', restarting: '重启中', paused: '已暂停', dead: '已死亡' })[state] || state || '—'
      const openLogs = async (row, tail) => {
        setLogsTarget(row)
        setLogsTail(tail)
        setLogsText('加载中…')
        try {
          const data = await call(ctx, { action: 'resource-container-logs', id: focus.id, containerId: row.id, tail })
          setLogsText(data.text || '（暂无日志）')
        } catch (reason) { setLogsText(reason.message || '读取日志失败') }
      }
      const runBatch = async (op) => {
        const verb = { start: '启动', stop: '停止', restart: '重启', remove: '删除' }[op]
        if (!window.confirm(`确定${verb}已选中的 ${selectedIds.length} 个容器吗？`)) return
        setBatchOpen(false)
        try {
          await call(ctx, { action: 'resource-container-act', id: focus.id, containerIds: selectedIds, op })
          setSelectedIds([])
          await openInstances(focus)
        } catch (reason) { setInstanceError(reason.message || '批量操作失败') }
      }
      const closeDebug = () => {
        if (debugSocket.current) debugSocket.current.close()
        debugSocket.current = null
        setDebugTarget(null)
        setDebugTree({})
        setDebugOpenDirs({ '/': true })
        setDebugDirError('')
        setDebugDrop('')
      }
      const debugFs = (payload) => new Promise((resolve, reject) => {
        const id = `fs-${Date.now()}-${Math.random().toString(16).slice(2)}`
        const socket = debugSocket.current
        if (!socket || socket.readyState !== 1) { reject(new Error('调试连接未就绪')); return }
        debugWaits.current[id] = { resolve, reject }
        socket.send(JSON.stringify({ type: 'fs', id, ...payload }))
      })
      const loadDebugDir = async (path) => {
        if (!debugTarget) return
        try {
          await debugReady.current
          const result = await debugFs({ op: 'list', path })
          setDebugTree(current => ({ ...current, [path]: result.entries || [] }))
          setDebugDirError('')
        } catch (reason) {
          setDebugDirError(reason.message || '目录读取失败')
        }
      }
      const debugTasksRef = useRef([])
      debugTasksRef.current = debugTasks
      useEffect(() => {
        if (!debugTasks.some(item => item.status === 'running')) return undefined
        const timer = setInterval(() => { setDebugClock(value => value + 1) }, 500)
        return () => { clearInterval(timer) }
      }, [debugTasks])
      const debugTargetRef = () => ({
        id: debugTarget ? (debugTarget.resourceId || (focus && focus.id) || '') : '',
        containerId: debugTarget && !debugTarget.host ? (debugTarget.id || '') : '',
      })
      const parentPath = (full) => { const index = full.lastIndexOf('/'); return index <= 0 ? '/' : full.slice(0, index) }
      const patchTask = (id, patch) => setDebugTasks(list => list.map(item => item.id === id ? { ...item, ...patch } : item))
      const noteBytes = (id, loaded, total) => setDebugTasks(list => list.map(item => {
        if (item.id !== id) return item
        const elapsed = (item.elapsed || 0) + (item.runAt ? Date.now() - item.runAt : 0)
        const speed = elapsed > 300 ? loaded * 1000 / elapsed : (item.speed || 0)
        return { ...item, loaded, total, speed, progress: total > 0 ? Math.round(loaded * 100 / total) : item.progress }
      }))
      const freezeTask = (id, patch) => setDebugTasks(list => list.map(item => {
        if (item.id !== id) return item
        const elapsed = (item.elapsed || 0) + (item.runAt ? Date.now() - item.runAt : 0)
        const average = item.loaded && elapsed > 0 ? item.loaded * 1000 / elapsed : (item.speed || 0)
        return { ...item, ...patch, elapsed, runAt: 0, speed: patch.status === 'error' ? 0 : average }
      }))
      const clockText = (ms) => {
        const total = Math.max(0, Math.floor(ms / 1000))
        const hours = Math.floor(total / 3600)
        const minutes = Math.floor((total % 3600) / 60)
        const seconds = total % 60
        const pair = (value) => String(value).padStart(2, '0')
        return hours > 0 ? `${hours}:${pair(minutes)}:${pair(seconds)}` : `${pair(minutes)}:${pair(seconds)}`
      }
      const speedText = (value) => {
        if (!value || value < 1) return '0 B/s'
        if (value < 1024) return `${Math.round(value)} B/s`
        if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB/s`
        return `${(value / 1024 / 1024).toFixed(1)} MB/s`
      }
      const reloadDir = async (dir) => {
        const box = debugFiles.current
        const top = box ? box.scrollTop : 0
        await loadDebugDir(dir)
        requestAnimationFrame(() => { if (debugFiles.current) debugFiles.current.scrollTop = top })
      }
      const runUpload = async (task) => {
        const socket = debugSocket.current
        if (!socket || socket.readyState !== 1) throw new Error('调试连接未就绪')
        const bytes = new Uint8Array(await task.file.arrayBuffer())
        await new Promise((resolve, reject) => {
          const step = 24 * 1024
          let offset = 0
          const finish = (error) => { delete debugWaits.current[task.id]; error ? reject(error) : resolve() }
          const pump = () => {
            if (offset >= bytes.length) { socket.send(JSON.stringify({ type: 'fs', id: task.id, op: 'upload-end' })); return }
            const slice = bytes.subarray(offset, offset + step)
            let text = ''
            for (let index = 0; index < slice.length; index += 1) text += String.fromCharCode(slice[index])
            socket.send(JSON.stringify({ type: 'fs', id: task.id, op: 'upload-chunk', data: btoa(text) }))
            offset += slice.length
            noteBytes(task.id, offset, bytes.length)
            setTimeout(pump, 0)
          }
          debugWaits.current[task.id] = { chunk: (message) => { if (message.error) finish(new Error(message.error)); else if (message.done) finish(); else if (message.ok) pump() } }
          debugStops.current[task.id] = () => { socket.send(JSON.stringify({ type: 'fs', id: task.id, op: 'cancel' })); finish(Object.assign(new Error('暂停'), { paused: true })) }
          socket.send(JSON.stringify({ type: 'fs', id: task.id, op: 'upload-begin', dir: task.dir, name: task.name, size: bytes.length }))
        })
      }
      const runDownload = async (task) => {
        const socket = debugSocket.current
        if (!socket || socket.readyState !== 1) throw new Error('调试连接未就绪')
        const chunks = []
        await new Promise((resolve, reject) => {
          const finish = (error) => { delete debugWaits.current[task.id]; error ? reject(error) : resolve() }
          debugWaits.current[task.id] = { chunk: (message) => {
            if (message.error) { finish(new Error(message.error)); return }
            if (message.data) {
              const raw = Uint8Array.from(atob(message.data), char => char.charCodeAt(0))
              chunks.push(raw)
              noteBytes(task.id, chunks.reduce((sum, item) => sum + item.length, 0), message.total || 0)
            }
            if (message.done) finish()
          } }
          debugStops.current[task.id] = () => { socket.send(JSON.stringify({ type: 'fs', id: task.id, op: 'cancel' })); finish(Object.assign(new Error('暂停'), { paused: true })) }
          socket.send(JSON.stringify({ type: 'fs', id: task.id, op: 'download', path: task.path }))
        })
        const blob = new Blob(chunks)
        const link = document.createElement('a')
        link.href = URL.createObjectURL(blob)
        link.download = task.name
        link.click()
        URL.revokeObjectURL(link.href)
      }
      const runPaste = async (task) => {
        patchTask(task.id, { progress: 30 })
        await debugFs({ op: 'paste', path: task.path, dir: task.dir })
      }
      const beginTask = async (task) => {
        if (task.file && task.file.size > 512 * 1024 * 1024) {
          freezeTask(task.id, { status: 'error', speed: 0, message: '文件超过 512MB' })
          return
        }
        patchTask(task.id, { status: 'running', runAt: Date.now(), speed: 0 })
        try {
          if (task.kind === '上传') await runUpload(task)
          else if (task.kind === '下载') await runDownload(task)
          else await runPaste(task)
          freezeTask(task.id, { progress: 100, status: 'done' })
          if (task.dir) await reloadDir(task.dir)
        } catch (reason) {
          if (reason && (reason.paused || reason.name === 'AbortError')) freezeTask(task.id, { status: 'paused' })
          else freezeTask(task.id, { status: 'error', speed: 0, message: reason.message || '传输失败' })
        }
      }
      const enqueueTask = (task) => {
        debugSeq.current += 1
        const next = { ...task, seq: debugSeq.current }
        setDebugTasks(list => [next, ...list])
        void beginTask(next)
      }
      const pauseTask = (id) => { const stop = debugStops.current[id]; if (stop) stop() }
      const resumeTask = (id) => {
        const task = debugTasksRef.current.find(item => item.id === id)
        if (task && task.status !== 'running' && task.status !== 'done') void beginTask({ ...task, progress: 0 })
      }
      const sendDebug = (text) => {
        const socket = debugSocket.current
        if (!socket || socket.readyState !== 1 || text === '') return
        socket.send(JSON.stringify({ type: 'data', text }))
      }
      const onDebugKey = (event) => {
        const keys = { Tab: '\t', Enter: '\r', Backspace: '\u007f', ArrowUp: '\u001b[A', ArrowDown: '\u001b[B', ArrowRight: '\u001b[C', ArrowLeft: '\u001b[D' }
        if (keys[event.key]) { event.preventDefault(); sendDebug(keys[event.key]); return }
        if (event.ctrlKey && event.key.length === 1) {
          const code = event.key.toLowerCase().charCodeAt(0)
          if (code >= 97 && code <= 122) { event.preventDefault(); sendDebug(String.fromCharCode(code - 96)); }
          return
        }
        if (event.key.length === 1 && !event.metaKey && !event.altKey) { event.preventDefault(); sendDebug(event.key) }
      }
      const termCells = () => {
        const box = termBody.current
        if (!box) return { cols: 100, rows: 32 }
        const style = getComputedStyle(box)
        const probe = document.createElement('span')
        probe.textContent = '0000000000'
        probe.style.cssText = `position:absolute;visibility:hidden;font:${style.font};white-space:pre`
        document.body.appendChild(probe)
        const char = Math.max(probe.getBoundingClientRect().width / 10, 1)
        probe.remove()
        const padX = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0)
        const padY = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0)
        const line = parseFloat(style.lineHeight) || char * 1.45
        return {
          cols: Math.max(40, Math.floor((box.clientWidth - padX) / char)),
          rows: Math.max(16, Math.floor((box.clientHeight - padY) / line)),
        }
      }
      const openDebug = async (row) => {
        if (debugSocket.current) debugSocket.current.close()
        let markReady = () => {}
        debugReady.current = new Promise(resolve => { markReady = resolve })
        setDebugTarget(row)
        setTermPos(null)
        setDebugView({ rows: ['正在连接…'], row: 0, col: 0 })
        await new Promise(resolve => { requestAnimationFrame(() => { requestAnimationFrame(resolve) }) })
        const fitted = termCells()
        const cols = fitted.cols
        const rows = fitted.rows
        try {
          const issued = await call(ctx, { action: 'debug-ticket', id: row.resourceId || focus.id, containerId: row.host ? '' : row.id })
          const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
          const socket = new WebSocket(`${proto}//${location.host}/api/cpm/debug?ticket=${encodeURIComponent(issued.ticket)}`)
          debugSocket.current = socket
          socket.onmessage = (event) => {
            const message = JSON.parse(String(event.data))
            if (message.type === 'challenge') {
              socket.send(JSON.stringify({ type: 'answer', digest: sha256(`${issued.ticket}:${message.nonce}`), cols, rows }))
            } else if (message.type === 'ready') {
              markReady()
            } else if (message.type === 'fs') {
              const wait = debugWaits.current[message.id]
              if (!wait) return
              if (wait.chunk) wait.chunk(message)
              else if (message.error) { delete debugWaits.current[message.id]; wait.reject(new Error(message.error)) }
              else { delete debugWaits.current[message.id]; wait.resolve(message) }
            } else if (message.type === 'data') {
              setDebugView(screen => feedTerminal(screen.rows[0] === '正在连接…' ? { rows: [''], row: 0, col: 0 } : screen, String(message.text || '')))
            } else if (message.type === 'closed') {
              markReady()
              setDebugView(screen => feedTerminal(screen, '\r\n连接已断开\r\n'))
            }
          }
          socket.onclose = () => { markReady() }
          socket.onerror = () => { setDebugView(screen => feedTerminal(screen, '\r\n调试连接失败\r\n')) }
          const box = termBody.current
          if (box && typeof ResizeObserver === 'function') {
            let last = `${cols}x${rows}`
            const observer = new ResizeObserver(() => {
              const next = termCells()
              const mark = `${next.cols}x${next.rows}`
              if (mark === last || socket.readyState !== 1) return
              last = mark
              socket.send(JSON.stringify({ type: 'resize', cols: next.cols, rows: next.rows }))
            })
            observer.observe(box)
            socket.addEventListener('close', () => { observer.disconnect() })
          }
        } catch (reason) {
          markReady()
          setDebugView({ rows: [reason.message || '进入容器失败'], row: 0, col: 0 })
        }
      }
      const detailView = (item) => {
        const live = liveOf(item.id) || {}
        const host = live.host || {}
        const cpu = live.cpu || {}
        const memory = live.memory || {}
        const load = live.load || {}
        const accel = live.nvidia && Array.isArray(live.nvidia.gpus) && live.nvidia.gpus.length ? live.nvidia : (live.iluvatar || null)
        const gpus = accel && Array.isArray(accel.gpus) ? accel.gpus : []
        const disks = Array.isArray(live.disk) ? live.disk : []
        const networks = Array.isArray(live.network) ? live.network : []
        const kv = (pairs) => h('dl', { className: 'dsh-cpm-kv' }, pairs.map(([label, value]) => h('div', { key: label }, h('dt', null, label), h('dd', null, value || '—'))))
        return h('div', { className: 'dsh-cpm-detail' },
          h('div', { className: 'dsh-cpm-detail-head dsh-cpm-panel' },
            h('button', { type: 'button', className: 'dsh-cpm-identity', onClick: () => { setScreen('list') } },
              item.icon && String(item.icon).startsWith('data:image/') ? h('img', { className: 'dsh-cpm-card-icon', src: item.icon, alt: '' }) : null,
              h('span', null, h('h2', { style: { margin: 0 } }, item.name), h('span', { style: { display: 'block', color: '#86909c', fontSize: '12px' } }, `${item.nodeIp}${host.hostname ? ` · ${host.hostname}` : ''}`))),
            h('span', { className: 'dsh-cpm-status', 'data-status': item.status || '启动中' }, item.status || '启动中'),
            h('button', { type: 'button', className: 'dsh-cpm-btn', style: { marginLeft: 'auto' }, onClick: () => { void openInstances(item) } }, '运行实例')),
          h('div', { className: 'dsh-cpm-detail-grid' },
            h('section', { className: 'dsh-cpm-panel dsh-cpm-metric' }, h('h2', null, '主机'), kv([['主机名', host.hostname], ['系统', [host.platform, host.platform_version].filter(Boolean).join(' ')], ['内核', [host.kernel_version, host.kernel_arch].filter(Boolean).join(' / ')], ['运行时长', uptimeText(host.uptime_seconds)], ['采集时间', live.collected_at ? new Date(live.collected_at).toLocaleString() : '']])),
            h('section', { className: 'dsh-cpm-panel dsh-cpm-metric' }, h('h2', null, 'CPU'), h('p', { className: 'dsh-cpm-metric-big' }, pct(cpu.usage_percent)), meter(cpu.usage_percent), kv([['型号', cpu.model_name], ['核心', `${cpu.physical_cores ?? '—'} 物理 / ${cpu.logical_cores ?? '—'} 逻辑`], ['频率', cpu.mhz ? `${cpu.mhz} MHz` : ''], ['负载', `${load.load1 ?? '—'} / ${load.load5 ?? '—'} / ${load.load15 ?? '—'}`]])),
            h('section', { className: 'dsh-cpm-panel dsh-cpm-metric' }, h('h2', null, '内存'), h('p', { className: 'dsh-cpm-metric-big' }, pct(memory.used_percent)), meter(memory.used_percent), kv([['已用', bytes(memory.used_bytes)], ['可用', bytes(memory.available_bytes)], ['总量', bytes(memory.total_bytes)], ['Swap', `${bytes(memory.swap_used_bytes)} / ${bytes(memory.swap_total_bytes)}`]]))),
          h('section', { className: 'dsh-cpm-panel' },
            h('div', { className: 'dsh-cpm-section-head' },
              h('h2', null, '计算卡'),
              h('span', { style: { color: '#86909c', fontSize: '12px' } }, gpus.length === 0 ? `配置类型：${(item.cardTypes || []).join(' / ') || '—'}` : `共 ${gpus.length} 张 · ${live.iluvatar && accel === live.iluvatar ? '天数' : 'NVIDIA'}${accel && accel.driver_version ? ` · Driver ${accel.driver_version}` : ''}${accel && accel.cuda_version ? ` · CUDA ${accel.cuda_version}` : ''}`)),
            gpus.length === 0 ? h('p', { style: { color: '#86909c' } }, accel && accel.error ? `无法读取计算卡数据：${accel.error}` : '暂无计算卡使用数据') : gpus.map(gpu => {
              const processes = Array.isArray(gpu.processes) ? gpu.processes : []
              const meta = (label, value) => h('div', { key: label }, h('dt', null, label), h('dd', null, value))
              return h('article', { key: gpu.uuid || gpu.index },
                h('div', { className: 'dsh-cpm-gpu-title' },
                  h('div', null,
                    h('strong', null, gpu.name || `GPU ${gpu.index}`),
                    h('p', null, `#${gpu.index ?? ''}${gpu.uuid ? ` · ${gpu.uuid}` : gpu.bus_id ? ` · ${gpu.bus_id}` : ''}${gpu.compute_capability ? ` · CC ${gpu.compute_capability}` : ''}`)),
                  h('span', { className: 'dsh-cpm-gpu-temp' }, `${gpu.temperature_c ?? '—'}°C`)),
                h('div', { className: 'dsh-cpm-gpu-usage' },
                  h('div', null,
                    h('span', { className: 'dsh-cpm-gpu-label' }, 'GPU 利用率'),
                    h('div', { className: 'dsh-cpm-usage-cell' }, meter(gpu.utilization_gpu_percent), h('span', null, `${gpu.utilization_gpu_percent ?? 0}%`))),
                  h('div', null,
                    h('span', { className: 'dsh-cpm-gpu-label' }, '显存占用'),
                    h('div', { className: 'dsh-cpm-usage-cell' }, meter(gpu.memory_used_percent), h('span', null, pct(gpu.memory_used_percent))),
                    h('p', { style: { margin: '6px 0 0', color: '#86909c', fontSize: '12px' } }, `${gpu.memory_used_mib ?? 0} / ${gpu.memory_total_mib ?? 0} MiB · 空闲 ${gpu.memory_free_mib ?? 0} MiB`)),
                  h('div', null,
                    h('span', { className: 'dsh-cpm-gpu-label' }, '功耗'),
                    h('div', { className: 'dsh-cpm-usage-cell' }, meter(gpu.power_limit_w ? (Number(gpu.power_draw_w) / Number(gpu.power_limit_w)) * 100 : 0), h('span', null, gpu.power_draw_w == null ? '—' : `${gpu.power_draw_w}${gpu.power_limit_w != null ? ` / ${gpu.power_limit_w} W` : ' W'}`)))),
                h('dl', { className: 'dsh-cpm-gpu-meta' },
                  meta('风扇', `${gpu.fan_speed_percent ?? '—'}%`),
                  meta('核心频率', `${gpu.clock_graphics_mhz ?? gpu.clock_sm_mhz ?? '—'} MHz`),
                  meta('显存频率', `${gpu.clock_memory_mhz ?? '—'} MHz`),
                  meta('PCIe', gpu.pcie_link_gen != null ? `Gen${gpu.pcie_link_gen} x${gpu.pcie_link_width ?? '—'}` : (gpu.bus_id || '—')),
                  meta('显存利用率', `${gpu.utilization_memory_percent ?? 0}%`),
                  meta(live.iluvatar && accel === live.iluvatar ? '计算模式' : 'VBIOS', gpu.compute_mode || gpu.vbios_version || '—')),
                processes.length === 0 ? h('p', { style: { margin: 0, color: '#86909c', fontSize: '12px' } }, '当前无 GPU 计算进程') : h('div', null,
                  h('div', { style: { marginBottom: '6px', color: '#86909c', fontSize: '12px' } }, `运行进程（${processes.length}）`),
                  h('table', { className: 'dsh-cpm-table' },
                    h('thead', null, h('tr', null, ['PID', '进程', '类型', '显存'].map(label => h('th', { key: label }, label)))),
                    h('tbody', null, processes.map(proc => h('tr', { key: proc.pid }, h('td', null, String(proc.pid)), h('td', null, proc.process_name || '—'), h('td', null, proc.type || '—'), h('td', null, `${proc.used_memory_mib ?? 0} MiB`)))))))
            })),
          h('section', { className: 'dsh-cpm-panel' }, h('h2', null, '磁盘'),
            h('table', { className: 'dsh-cpm-table' }, h('thead', null, h('tr', null, ['挂载点', '设备', '文件系统', '已用', '可用', '容量', '使用率'].map(label => h('th', { key: label }, label)))),
              h('tbody', null, disks.map(disk => h('tr', { key: disk.mountpoint }, h('td', null, disk.mountpoint), h('td', null, disk.device), h('td', null, disk.fstype || '—'), h('td', null, bytes(disk.used_bytes)), h('td', null, bytes(disk.free_bytes)), h('td', null, bytes(disk.total_bytes)), h('td', { className: 'dsh-cpm-usage-cell' }, meter(disk.used_percent), h('span', null, pct(disk.used_percent)))))))),
          h('section', { className: 'dsh-cpm-panel' }, h('h2', null, '网络'),
            h('table', { className: 'dsh-cpm-table' }, h('thead', null, h('tr', null, ['网卡', '发送', '接收', '发送包', '接收包'].map(label => h('th', { key: label }, label)))),
              h('tbody', null, networks.map(nic => h('tr', { key: nic.name }, h('td', null, nic.name), h('td', null, bytes(nic.bytes_sent)), h('td', null, bytes(nic.bytes_recv)), h('td', null, nic.packets_sent ?? '—'), h('td', null, nic.packets_recv ?? '—')))))))
      }
      const instanceView = (item) => {
        const keyword = instKeyword.trim().toLowerCase()
        const images = [...new Set(instances.map(row => row.image).filter(Boolean))].sort()
        const rows = instances.filter(row => {
          if (instState && row.state !== instState) return false
          if (instImage && row.image !== instImage) return false
          if (!keyword) return true
          return [row.name, row.image, row.id, row.ports, row.status, row.state, row.command].join(' ').toLowerCase().includes(keyword)
        }).sort((left, right) => {
          const result = String(left[instSort] || '').localeCompare(String(right[instSort] || ''), 'zh-CN')
          return instDir === 'desc' ? -result : result
        })
        const running = instances.filter(row => row.state === 'running').length
        const allChecked = rows.length > 0 && rows.every(row => selectedIds.includes(row.id))
        return h('div', { className: 'dsh-cpm-detail' },
          h('div', { className: 'dsh-cpm-detail-head dsh-cpm-panel' },
            h('button', { type: 'button', className: 'dsh-cpm-identity', onClick: () => { setScreen('detail'); setLogsTarget(null); closeDebug() } },
              h('span', null,
                h('h2', { style: { margin: 0 } }, `${item.name} · 运行实例`),
                h('span', { style: { display: 'block', color: '#86909c', fontSize: '12px' } }, `${item.nodeIp} · 共 ${instances.length} 个容器，${running} 个运行中`))),
            h('span', { className: 'dsh-cpm-status', 'data-status': item.status || '启动中' }, item.status || '启动中')),
          instanceError !== '' ? h('p', { className: 'dsh-cpm-error' }, instanceError) : null,
          h('section', { className: 'dsh-cpm-panel' },
            h('div', { className: 'dsh-cpm-toolbar-row' },
              h('div', { className: 'dsh-cpm-filter' }, '运行状态', h(RoundMenu, { value: instState, options: [['', '全部状态'], ['running', '运行中'], ['exited', '已停止'], ['created', '已创建'], ['restarting', '重启中'], ['paused', '已暂停'], ['dead', '已死亡']].map(([id, label]) => ({ id, label })), onChange: setInstState })),
              h('label', null, '镜像', h('select', { value: instImage, onChange: event => { setInstImage(event.target.value) } }, [h('option', { key: 'all', value: '' }, '全部镜像'), ...images.map(image => h('option', { key: image, value: image }, image))])),
              h('div', { className: 'dsh-cpm-filter' }, '排序', h(RoundMenu, { className: 'dsh-cpm-sort', value: instSort, options: [['name', '名称'], ['image', '镜像名称'], ['state', '运行状态'], ['status', '状态详情']].map(([id, label]) => ({ id, label })), onChange: setInstSort })),
              h('button', { type: 'button', className: 'dsh-cpm-btn', onClick: () => { setInstDir(instDir === 'asc' ? 'desc' : 'asc') } }, instDir === 'asc' ? '升序' : '降序'),
              h('button', { type: 'button', className: 'dsh-cpm-btn', onClick: () => { setInstKeyword(''); setInstState(''); setInstImage('') } }, '重置筛选'),
              h('div', { className: 'dsh-cpm-toolbar-end' },
                h('label', null, '搜索', h('input', { value: instKeyword, placeholder: '名称 / 镜像 / ID / 端口', onChange: event => { setInstKeyword(event.target.value) } })),
                h('div', { className: 'dsh-cpm-batch' },
                  h('button', { type: 'button', className: 'dsh-cpm-btn', onClick: () => { setBatchOpen(!batchOpen) } }, `批量操作${selectedIds.length ? ` (${selectedIds.length})` : ''}`),
                  batchOpen ? h('div', { className: 'dsh-cpm-batch-menu' }, ['start', 'stop', 'restart', 'remove'].map(op => h('button', { key: op, type: 'button', disabled: selectedIds.length === 0, onClick: () => { void runBatch(op) } }, { start: '批量启动', stop: '批量停止', restart: '批量重启', remove: '批量删除' }[op]))) : null),
                h('button', { type: 'button', className: 'dsh-cpm-btn', onClick: () => { void openInstances(item) } }, '刷新'))),
            instancesLoading ? h('div', { className: 'dsh-cpm-loading' }, h('i', { className: 'dsh-cpm-spin' }), '正在加载') : rows.length === 0 ? h('p', null, instances.length === 0 ? '该节点暂无容器' : '没有符合筛选条件的容器') : h('table', { className: 'dsh-cpm-table' },
              h('thead', null, h('tr', null,
                h('th', null, h('input', { type: 'checkbox', checked: allChecked, onChange: () => { setSelectedIds(allChecked ? [] : rows.map(row => row.id)) } })),
                ['状态', '名称', '镜像', '容器 ID', '端口', '详情', '操作'].map(label => h('th', { key: label }, label)))),
              h('tbody', null, rows.map(row => h('tr', { key: row.id || row.name },
                h('td', null, h('input', { type: 'checkbox', checked: selectedIds.includes(row.id), onChange: () => { setSelectedIds(selectedIds.includes(row.id) ? selectedIds.filter(id => id !== row.id) : [...selectedIds, row.id]) } })),
                h('td', null, h('span', { className: 'dsh-cpm-state', 'data-state': row.state }, stateLabel(row.state))),
                h('td', null, row.name || '—'),
                h('td', null, row.image || '—'),
                h('td', null, row.id),
                h('td', null, row.ports || '—'),
                h('td', null, row.status || '—'),
                h('td', null,
                  h('button', { type: 'button', className: 'dsh-cpm-link', disabled: row.state !== 'running', onClick: () => { void openDebug(row) } }, '调试'),
                  h('button', { type: 'button', className: 'dsh-cpm-link', onClick: () => { void openLogs(row, logsTail) } }, '日志'))))))),
          logsTarget ? h('div', { className: 'dsh-cpm-overlay', onClick: () => { setLogsTarget(null) } },
            h('div', { className: 'dsh-cpm-float', onClick: event => { event.stopPropagation() } },
              h('div', { className: 'dsh-cpm-detail-head' }, h('h3', { style: { margin: 0 } }, `日志 · ${logsTarget.name || logsTarget.id}`), [100, 500, 1000].map(tail => h('button', { key: tail, type: 'button', className: 'dsh-cpm-btn', 'data-active': logsTail === tail ? 'true' : 'false', onClick: () => { void openLogs(logsTarget, tail) } }, `最近 ${tail}`)), h('button', { type: 'button', className: 'dsh-cpm-btn', onClick: () => { setLogsTarget(null) } }, '关闭')),
              h('pre', null, logsText))) : null)
      }
      const debugMark = (name, kind) => {
        const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : ''
        const type = kind === 'dir' ? 'dir' : ['zip', 'tar', 'gz', 'tgz', 'bz2', '7z', 'rar', 'xz'].includes(ext) ? 'archive' : ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico'].includes(ext) ? 'image' : ['txt', 'md', 'log', 'csv', 'json', 'yml', 'yaml', 'xml', 'ini', 'conf'].includes(ext) ? 'text' : ['pdf', 'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx'].includes(ext) ? 'doc' : ['mp4', 'mov', 'avi', 'mkv', 'webm'].includes(ext) ? 'video' : 'blank'
        const paths = {
          dir: 'M3 5h5l2 2h9v8H3z',
          archive: 'M6 3h8l3 3v11H6zM9 6h2v2H9zM9 10h2v2H9z',
          image: 'M4 4h12v10H4zM6 11l2-2 2 2 2-3 2 3',
          text: 'M5 3h7l3 3v9H5zM7 8h6M7 11h6',
          doc: 'M5 3h7l3 3v9H5zM8 9h4',
          video: 'M4 5h9v8H4zM13 8l3-2v6l-3-2z',
          blank: 'M5 3h7l3 3v9H5z',
        }
        return h('svg', { width: 14, height: 14, viewBox: '0 0 18 16', fill: 'none', stroke: type === 'dir' ? '#f5b942' : '#86909c', strokeWidth: 1.4, 'aria-hidden': 'true' }, h('path', { d: paths[type], fill: type === 'dir' ? '#f6c445' : 'none' }))
      }
      const downloadDebugFile = (full, name) => {
        if (!debugTarget) return
        const id = debugTarget.resourceId || (focus && focus.id) || ''
        const containerId = debugTarget.host ? '' : (debugTarget.id || '')
        const url = `${API_URL}?debugFile=${encodeURIComponent(full)}&id=${encodeURIComponent(id)}&containerId=${encodeURIComponent(containerId)}`
        void fetch(url, { credentials: 'same-origin' }).then(async response => {
          if (!response.ok) throw new Error('下载失败')
          const blob = await response.blob()
          const link = document.createElement('a')
          link.href = URL.createObjectURL(blob)
          link.download = name
          link.click()
          URL.revokeObjectURL(link.href)
        }).catch(reason => { setDebugDirError(reason.message || '下载失败') })
      }
      const renderDebugDir = (path, depth = 0) => {
        const entries = debugTree[path]
        if (!entries) return depth === 0 ? h('p', null, '正在读取…') : null
        return entries.map(entry => {
          const full = `${path.replace(/\/$/, '')}/${entry.name}`
          const pad = 4 + depth * 14
          const pick = (event, entryKind) => {
            event.preventDefault()
            event.stopPropagation()
            setDebugSelected(full)
            setDebugMenu({ kind: 'entry', x: event.clientX, y: event.clientY, path: full, name: entry.name, entryKind })
          }
          if (entry.kind !== 'dir') {
            return h('div', {
              key: full, className: 'dsh-cpm-term-line', 'data-dir': path, 'data-on': debugSelected === full ? 'true' : 'false', style: { paddingLeft: pad },
              onClick: () => { setDebugSelected(full) },
              onContextMenu: event => { pick(event, 'file') },
            },
              h('div', { className: 'dsh-cpm-term-entry', 'data-kind': 'file' }, debugMark(entry.name, 'file'), h('span', null, entry.name)),
              h('span', { className: 'dsh-cpm-term-size' }, fileSize(entry.size)),
              h('button', { type: 'button', className: 'dsh-cpm-term-down', title: '下载', 'aria-label': '下载', onClick: event => { event.stopPropagation(); enqueueTask({ id: `dl-${Date.now()}`, kind: '下载', name: entry.name, path: full, dir: path, progress: 0, status: 'wait' }) } }, h('svg', { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, 'aria-hidden': 'true' }, h('path', { d: 'M12 4v11M7 11l5 5 5-5M5 20h14' }))))
          }
          const open = debugOpenDirs[full] === true
          return h('div', { key: full },
            h('button', {
              type: 'button', className: 'dsh-cpm-term-line dsh-cpm-term-entry', 'data-kind': 'dir', 'data-dir': full, 'data-on': debugSelected === full || debugDrop === full ? 'true' : 'false', style: { paddingLeft: pad },
              onClick: () => {
                setDebugSelected(full)
                setDebugOpenDirs(current => ({ ...current, [full]: !open }))
                if (!open && debugTree[full] === undefined) void loadDebugDir(full)
              },
              onContextMenu: event => { pick(event, 'dir') },
            }, debugMark(entry.name, 'dir'), h('span', null, entry.name)),
            open ? renderDebugDir(full, depth + 1) : null)
        })
      }
      const debugNode = debugTarget ? h('div', { className: 'dsh-cpm-overlay' },
        h('div', { className: 'dsh-cpm-term', style: termPos ? { position: 'fixed', left: `${termPos.x}px`, top: `${termPos.y}px`, width: `${termSize.w}px`, height: `${termSize.h}px` } : { width: `${termSize.w}px`, height: `${termSize.h}px` } },
          h('div', { className: 'dsh-cpm-term-head', onPointerDown: dragTerm },
            h('div', null,
              h('h3', null, `调试 · ${debugTarget.name || debugTarget.id}`),
              h('p', null, debugTarget.host ? `已连接服务器 · ${debugTarget.image || ''}` : `已连接 · ${debugTarget.image || debugTarget.id}`)),
            h('button', { type: 'button', className: 'dsh-cpm-icon', onClick: () => { closeDebug() } }, '×')),
          h('div', { className: 'dsh-cpm-term-main' },
          h('aside', {
            ref: debugFiles, className: 'dsh-cpm-term-files', style: { width: debugPane }, 'data-dir': '/', 'data-drop': debugDrop === '/' ? 'true' : 'false',
            onDragOver: event => {
              if (![...event.dataTransfer.types].includes('Files')) return
              event.preventDefault()
              const marked = event.target.closest ? event.target.closest('[data-dir]') : null
              setDebugDrop(marked ? marked.getAttribute('data-dir') || '/' : '/')
            },
            onDragLeave: event => { if (!event.currentTarget.contains(event.relatedTarget)) setDebugDrop('') },
            onDrop: event => {
              event.preventDefault()
              const marked = event.target.closest ? event.target.closest('[data-dir]') : null
              const dir = marked ? marked.getAttribute('data-dir') || '/' : '/'
              setDebugDrop('')
              const files = [...event.dataTransfer.files]
              files.forEach((file, index) => enqueueTask({ id: `up-${Date.now()}-${index}`, kind: '上传', name: file.name, dir, path: dir, progress: 0, status: 'wait', file }))
            },
          }, debugDirError !== '' ? h('p', null, debugDirError) : null, renderDebugDir('/')),
          h('i', {
            className: 'dsh-cpm-term-split',
            onPointerDown: event => {
              event.preventDefault()
              const startX = event.clientX
              const start = debugPane
              const limit = Math.max(360, termSize.w - 320)
              const move = (ev) => { setDebugPane(Math.min(Math.max(start + ev.clientX - startX, 220), limit)) }
              const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
              window.addEventListener('pointermove', move)
              window.addEventListener('pointerup', up)
            },
          }),
          h('div', { ref: termBody, tabIndex: 0, className: 'dsh-cpm-term-body', onMouseDown: event => { event.currentTarget.focus() }, onKeyDown: onDebugKey, onPaste: event => { event.preventDefault(); sendDebug(event.clipboardData.getData('text')) } },
            debugView.rows.map((line, index) => {
              if (index !== debugView.row) return h('pre', { key: index }, line || ' ')
              const chars = Array.from(line)
              const left = chars.slice(0, debugView.col).join('')
              const mark = chars[debugView.col] || ' '
              const right = chars.slice(debugView.col + 1).join('')
              return h('pre', { key: index }, left, h('span', { className: 'dsh-cpm-caret' }, mark), right)
            })),
          ),
          h('div', { className: 'dsh-cpm-xfer', onMouseDown: () => { setDebugMenu(null) } },
            h('div', { className: 'dsh-cpm-xfer-row dsh-cpm-xfer-head' }, ['序号', '类型', '文件名', '进度', '状态', '速度', '耗时'].map(label => h('span', { key: label }, label))),
            debugTasks.length === 0 ? h('p', { className: 'dsh-cpm-term-size', style: { padding: 8 } }, '暂无传输') : debugTasks.map((task, index) => {
              const spent = (task.elapsed || 0) + (task.status === 'running' && task.runAt ? Date.now() - task.runAt : 0)
              const state = task.status === 'paused' ? '已暂停' : task.status === 'done' ? '完成' : task.status === 'error' ? '失败' : '正常'
              void debugClock
              return h('div', {
                key: task.id, className: 'dsh-cpm-xfer-row', 'data-on': debugTaskId === task.id ? 'true' : 'false', 'data-status': task.status,
                onClick: () => { setDebugTaskId(task.id) },
                onContextMenu: event => { event.preventDefault(); setDebugTaskId(task.id); setDebugMenu({ kind: 'task', x: event.clientX, y: event.clientY, taskId: task.id }) },
              }, h('span', null, String(task.seq || debugTasks.length - index)), h('span', null, task.kind), h('span', { title: task.message || '' }, task.name), h('span', { className: 'dsh-cpm-xfer-bar' }, h('i', { style: { width: `${task.progress}%` } })), h('span', { title: task.message || '' }, state), h('span', null, task.status === 'wait' || task.status === 'error' ? '—' : speedText(task.speed)), h('span', null, clockText(spent)))
            })),
          debugMenu === null ? null : h('div', { className: 'dsh-cpm-term-menu', style: { left: debugMenu.x, top: debugMenu.y }, onMouseDown: event => { event.stopPropagation() } },
            ...(() => {
              const menuItem = (label, run, disabled) => h('button', { key: label, type: 'button', disabled, onClick: () => { if (disabled) return; run(); setDebugMenu(null) } }, label)
              if (debugMenu.kind === 'task') {
                const current = debugTasks.find(item => item.id === debugMenu.taskId)
                const anyRunning = debugTasks.some(item => item.status === 'running')
                const anyPaused = debugTasks.some(item => item.status === 'paused')
                return [
                  menuItem('暂停', () => { pauseTask(debugMenu.taskId) }, !current || current.status !== 'running'),
                  menuItem('全部暂停', () => { debugTasksRef.current.filter(item => item.status === 'running').forEach(item => pauseTask(item.id)) }, !anyRunning),
                  h('hr', { key: 'split-resume' }),
                  menuItem('恢复', () => { resumeTask(debugMenu.taskId) }, !current || current.status !== 'paused'),
                  menuItem('全部恢复', () => { debugTasksRef.current.filter(item => item.status === 'paused').forEach(item => resumeTask(item.id)) }, !anyPaused),
                  h('hr', { key: 'split-delete' }),
                  menuItem('删除', () => { pauseTask(debugMenu.taskId); setDebugTasks(list => list.filter(item => item.id !== debugMenu.taskId)) }, false),
                  menuItem('全部删除', () => { debugTasksRef.current.forEach(item => pauseTask(item.id)); setDebugTasks([]) }, false),
                ]
              }
              return [
                menuItem('复制文件路径', () => { void navigator.clipboard.writeText(debugMenu.path) }, false),
                menuItem('复制', () => { setDebugClip({ path: debugMenu.path, name: debugMenu.name }) }, false),
                menuItem('粘贴', () => { const dir = debugMenu.entryKind === 'dir' ? debugMenu.path : parentPath(debugMenu.path); enqueueTask({ id: `paste-${Date.now()}`, kind: '粘贴', name: debugClip.name, path: debugClip.path, dir, progress: 0, status: 'wait' }) }, !debugClip),
                menuItem('重命名', () => { const next = window.prompt('新名称', debugMenu.name); if (next && next.trim() !== '' && next.trim() !== debugMenu.name) void debugFs({ op: 'rename', path: debugMenu.path, name: next.trim() }).then(() => reloadDir(parentPath(debugMenu.path))).catch(reason => { setDebugDirError(reason.message || '重命名失败') }) }, false),
                menuItem('删除', () => { void debugFs({ op: 'delete', path: debugMenu.path }).then(() => { setDebugSelected(''); return reloadDir(parentPath(debugMenu.path)) }).catch(reason => { setDebugDirError(reason.message || '删除失败') }) }, false),
              ]
            })()),
          h('i', { className: 'dsh-cpm-resize', onPointerDown: resizeTerm }))) : null
      const cards = h('div', { className: 'dsh-cpm-cards', 'data-gap': 'true' }, visible.map(item => {
        const caption = tab === 'containers' ? (item.reference || '') : (item.updatedAt ? new Date(item.updatedAt).toLocaleString() + ' 更新' : '')
        return h('article', {
          key: item.id || item.reference || item.name,
          className: 'dsh-cpm-card',
          onClick: () => { if (tab === 'resources') openDetail(item); else openContainer(item) },
        },
        h('div', { className: 'dsh-cpm-card-ops', onClick: event => { event.stopPropagation() } },
          tab === 'resources'
            ? h(React.Fragment, null,
              h('button', { type: 'button', title: '运行实例', 'aria-label': '运行实例', onClick: () => { void openInstances(item) } }, h('svg', { viewBox: '0 0 16 16' }, h('path', { d: 'M3 4.5h10M3 8h10M3 11.5h6' }))),
              h('button', { type: 'button', title: '调试', 'aria-label': '调试', onClick: () => { void openDebug({ host: true, resourceId: item.id, name: item.name, image: item.nodeIp }) } }, h('svg', { viewBox: '0 0 16 16' }, h('path', { d: 'M3 3.5h10v9H3zM5 6.5l1.8 1.5L5 9.5M8.2 9.5H11' }))),
              h('button', { type: 'button', title: '修改', 'aria-label': '修改', onClick: () => { openResource(item) } }, h('svg', { viewBox: '0 0 16 16' }, h('path', { d: 'M9.2 3.2l3.6 3.6M2.8 13.2l.7-2.8 7.2-7.2 2.1 2.1-7.2 7.2z' }))),
              h('button', { type: 'button', title: '删除', 'aria-label': '删除', onClick: () => { void remove('resource', item) } }, h('svg', { viewBox: '0 0 16 16' }, h('path', { d: 'M3.5 4.5h9M6.2 4.5V3.2h3.6v1.3M4.6 4.5l.5 8.2h5.8l.5-8.2' }))))
            : h(React.Fragment, null,
              h('button', { type: 'button', title: '部署', 'aria-label': '部署', onClick: () => { openDeploy(item) } }, h('svg', { viewBox: '0 0 16 16' }, h('path', { d: 'M8 12V3M5 6l3-3 3 3M3.5 13.5h9' }))),
              h('button', { type: 'button', title: '修改', 'aria-label': '修改', onClick: () => { openContainer(item) } }, h('svg', { viewBox: '0 0 16 16' }, h('path', { d: 'M9.2 3.2l3.6 3.6M2.8 13.2l.7-2.8 7.2-7.2 2.1 2.1-7.2 7.2z' }))),
              h('button', { type: 'button', title: '删除', 'aria-label': '删除', onClick: () => { if (item.id) void remove('container', item); else window.alert('仓库镜像还没有保存到本地，不能删除') } }, h('svg', { viewBox: '0 0 16 16' }, h('path', { d: 'M3.5 4.5h9M6.2 4.5V3.2h3.6v1.3M4.6 4.5l.5 8.2h5.8l.5-8.2' }))))) ,
        h('div', { className: 'dsh-cpm-card-top' },
          tab === 'resources'
            ? h('span', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
              item.icon && String(item.icon).startsWith('data:image/') ? h('img', { className: 'dsh-cpm-card-icon', src: item.icon, alt: '' }) : h('span', { className: 'dsh-cpm-card-icon' }),
              h('span', { className: 'dsh-cpm-status', 'data-status': item.status || '启动中' }, item.status || '启动中'))
            : h('span', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
              item.icon && String(item.icon).startsWith('data:image/') ? h('img', { className: 'dsh-cpm-card-icon', src: item.icon, alt: '' }) : null,
              h('span', { className: 'dsh-cpm-pill accent' }, item.imageVersion || 'latest'))),
        h('h3', null, item.name),
        h('div', { className: 'dsh-cpm-pills' },
          item.architecture ? h('span', { className: 'dsh-cpm-pill' }, item.architecture) : null,
          tab === 'resources' ? (item.cardTypes || []).map(card => h('span', { key: card, className: 'dsh-cpm-pill accent' }, card)) : null,
          tab === 'containers' ? h('span', { className: 'dsh-cpm-pill' }, item.imageSource === 'file' ? '镜像文件' : '镜像地址') : null,
          tab === 'resources' && item.nodeIp ? h('span', { className: 'dsh-cpm-pill' }, item.nodeIp) : null),
        tab === 'resources' ? h('div', { className: 'dsh-cpm-usage' },
          [['CPU', liveOf(item.id) && liveOf(item.id).cpu && liveOf(item.id).cpu.usage_percent], ['内存', liveOf(item.id) && liveOf(item.id).memory && liveOf(item.id).memory.used_percent], ['存储', diskPct(liveOf(item.id))]].map(([label, value]) => h('div', { key: label },
            h('span', null, label),
            h('span', { className: 'dsh-cpm-bar' }, h('i', { 'data-level': levelOf(value), style: { width: Math.min(100, Math.max(0, value || 0)) + '%' } })),
            h('span', { 'data-level': levelOf(value) }, pct(value))))) : null,
        h('p', null, caption))
      }))
      const fileWord = keyword.trim().toLowerCase()
      const fileHere = files.filter(item => {
        if ((item.parentId || '') !== fileParent) return false
        if (fileView === 'files' && item.kind !== 'file') return false
        if (item.kind === 'file' && fileType !== 'all' && fileGroup(item) !== fileType) return false
        if (fileWord !== '' && !item.name.toLowerCase().includes(fileWord)) return false
        return true
      })
      const crumbs = []
      let crumbId = fileParent
      while (crumbId !== '') {
        const found = files.find(item => item.id === crumbId)
        if (found === undefined) break
        crumbs.unshift(found)
        crumbId = found.parentId || ''
      }
      const rememberUploads = (event) => {
        const picked = [...(event.target.files || [])]
        event.target.value = ''
        if (picked.length === 0) return
        setUploadList(current => [...current, ...picked])
      }
      const startUpload = async () => {
        if (uploadList.length === 0 || uploadProgress !== null) return
        setUploadProgress({ done: 0, total: uploadList.length })
        try {
          for (let index = 0; index < uploadList.length; index += 1) {
            const file = uploadList[index]
            const dataBase64 = await new Promise((resolve, reject) => {
              const reader = new FileReader()
              reader.onload = () => { resolve(typeof reader.result === 'string' ? reader.result : '') }
              reader.onerror = () => { reject(new Error('读取文件失败')) }
              reader.readAsDataURL(file)
            })
            await call(ctx, { action: 'upload-file', name: file.name, parentId: fileParent, contentType: file.type || 'application/octet-stream', dataBase64 }, undefined, UPLOAD_TIMEOUT_MS)
            setUploadProgress({ done: index + 1, total: uploadList.length })
          }
          await loadFiles()
          setUploadOpen(false)
          setUploadList([])
          setUploadProgress(null)
        } catch (reason) {
          setUploadProgress(null)
          setError(reason.message || '上传失败')
        }
      }
      const filePages = Math.max(1, Math.ceil(fileHere.length / filePageSize))
      const fileCurrent = Math.min(filePage, filePages)
      const fileVisible = fileHere.slice((fileCurrent - 1) * filePageSize, fileCurrent * filePageSize)
      const fileCount = fileHere.filter(item => item.kind === 'file').length
      const uploadDialog = uploadOpen ? h('div', { className: 'dsh-cpm-overlay' },
        h('div', { className: 'dsh-cpm-dialog' },
          h('h2', null, '上传文件'),
          h('div', { className: 'dsh-cpm-body' },
            h('button', { type: 'button', className: 'dsh-cpm-pick', disabled: uploadProgress !== null, onClick: () => { if (fileInput.current) fileInput.current.click() } }, '点击选择文件'),
            h('input', { ref: fileInput, type: 'file', multiple: true, hidden: true, onChange: rememberUploads }),
            uploadList.length === 0 ? null : h('div', { className: 'dsh-cpm-upload-list' }, uploadList.map((file, index) => h('span', { key: `${file.name}-${index}` }, file.name)))),
          h('div', { className: 'dsh-cpm-dialog-foot dsh-cpm-upload-foot' },
            uploadProgress === null ? null : h('div', { className: 'dsh-cpm-upload-progress' },
              h('span', { className: 'dsh-cpm-upload-bar' }, h('i', { style: { width: `${Math.round((uploadProgress.done * 100) / Math.max(uploadProgress.total, 1))}%` } })),
              h('span', null, `${uploadProgress.done}/${uploadProgress.total}`)),
            h('div', { className: 'dsh-cpm-dialog-actions' },
              h('button', { type: 'button', className: 'dsh-cpm-btn dsh-cpm-primary', disabled: uploadList.length === 0 || uploadProgress !== null, onClick: () => { void startUpload() } }, '上传'),
              h('button', { type: 'button', className: 'dsh-cpm-btn', disabled: uploadProgress !== null, onClick: () => { setUploadOpen(false); setUploadList([]); setUploadProgress(null) } }, '取消'))))) : null
      const fileKind = (item) => {
        if (item.kind === 'folder') return 'folder'
        const name = String(item.name || '').toLowerCase()
        const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : ''
        if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico'].includes(ext)) return 'image'
        if (['mp4', 'mov', 'avi', 'mkv', 'webm'].includes(ext)) return 'video'
        if (['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a'].includes(ext)) return 'audio'
        if (['zip', 'tar', 'gz', 'tgz', 'bz2', '7z', 'rar', 'xz'].includes(ext)) return 'archive'
        if (ext === 'pdf') return 'pdf'
        if (['doc', 'docx'].includes(ext)) return 'word'
        if (['xls', 'xlsx', 'csv'].includes(ext)) return 'sheet'
        if (['ppt', 'pptx'].includes(ext)) return 'slide'
        if (['js', 'jsx', 'ts', 'tsx', 'py', 'go', 'java', 'c', 'cpp', 'h', 'sh', 'css', 'html', 'sql'].includes(ext)) return 'code'
        if (['txt', 'md', 'log', 'json', 'yml', 'yaml', 'xml', 'ini', 'conf'].includes(ext)) return 'text'
        return 'blank'
      }
      const fileMark = (kind) => {
        const paths = {
          folder: 'M3 6h6l2 2h8v8H3z',
          image: 'M3 4h14v10H3zM5 11l2.2-2 2 2 2.2-2.6L14 11',
          video: 'M3 5h9v8H3zM12 8l4-2v6l-4-2z',
          audio: 'M7 4v8M5 7v2M9 6v4M11 5v6M13 7v2',
          archive: 'M6 2h7l3 3v11H6zM9 6h2v1.5H9zM9 9h2v1.5H9zM9 12h2v1.5H9z',
          text: 'M5 2h7l3 3v11H5zM7 8h6M7 11h6M7 14h4',
          code: 'M7 6l-3 3 3 3M13 6l3 3-3 3M10 5l-2 8',
          pdf: 'M5 2h7l3 3v11H5zM8 9h4M8 12h3',
          word: 'M5 2h7l3 3v11H5zM8 8h4M8 11h4',
          sheet: 'M4 3h12v12H4zM4 7h12M4 11h12M8 3v12',
          slide: 'M3 4h14v8H3zM8 14l2 2 2-2',
          blank: 'M5 2h7l3 3v11H5z',
        }
        return h('span', { className: 'dsh-cpm-file-mark', 'data-kind': kind }, h('svg', { width: 20, height: 20, viewBox: '0 0 20 18', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, 'aria-hidden': 'true' }, h('path', { d: paths[kind] || paths.blank, fill: kind === 'folder' ? 'currentColor' : 'none' })))
      }
      const defaultPreviewBox = () => {
        const w = Math.min(980, window.innerWidth - 48)
        const h = Math.min(720, window.innerHeight - 48)
        return { x: Math.max(8, (window.innerWidth - w) / 2), y: Math.max(8, (window.innerHeight - h) / 2), w, h }
      }
      const beginPreviewGesture = (event, mode) => {
        if (event.button !== 0) return
        if (mode === 'move' && event.target.closest('button')) return
        event.preventDefault()
        event.stopPropagation()
        const start = previewBox || defaultPreviewBox()
        const originX = event.clientX
        const originY = event.clientY
        const onMove = ev => {
          const dx = ev.clientX - originX
          const dy = ev.clientY - originY
          let x = start.x
          let y = start.y
          let w = start.w
          let h = start.h
          if (mode === 'move') { x += dx; y += dy } else {
            if (mode.includes('e')) w += dx
            if (mode.includes('s')) h += dy
            if (mode.includes('w')) { w -= dx; x += dx }
            if (mode.includes('n')) { h -= dy; y += dy }
          }
          const minW = 420
          const minH = 320
          if (w < minW) { if (mode.includes('w')) x -= minW - w; w = minW }
          if (h < minH) { if (mode.includes('n')) y -= minH - h; h = minH }
          const limitW = Math.max(minW, window.innerWidth - 16)
          const limitH = Math.max(minH, window.innerHeight - 16)
          w = Math.min(w, limitW)
          h = Math.min(h, limitH)
          x = Math.min(Math.max(8, x), window.innerWidth - 80)
          y = Math.min(Math.max(8, y), window.innerHeight - 48)
          setPreviewBox({ x, y, w, h })
        }
        const onUp = () => {
          window.removeEventListener('pointermove', onMove)
          window.removeEventListener('pointerup', onUp)
        }
        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', onUp)
      }
      const shownPreview = fileOpen === null ? null : (previewBox || defaultPreviewBox())
      const fileBoard = h('div', { className: 'dsh-cpm-file-board' },
        fileParent === '' ? null : h('div', { className: 'dsh-cpm-crumb' },
          h('button', { type: 'button', onClick: () => { setFileParent(crumbs.length > 1 ? crumbs[crumbs.length - 2].id : ''); setFileOpen(null) } }, '返回上一级'),
          crumbs.map(item => h('span', { key: item.id }, ' / ', h('button', { type: 'button', onClick: () => { setFileParent(item.id); setFileOpen(null) } }, item.name)))),
        fileVisible.length === 0 ? h('div', { className: 'dsh-cpm-empty' }, '这个位置还没有内容') : h('div', { className: 'dsh-cpm-files' }, fileVisible.map(item => {
          const kind = fileKind(item)
          return h('button', {
            key: item.id, type: 'button', className: 'dsh-cpm-file', 'data-active': fileOpen && fileOpen.id === item.id ? 'true' : 'false',
            onClick: () => { if (item.kind === 'folder') { setFileParent(item.id); setFileOpen(null) } else setFileOpen(item) },
          }, fileMark(kind), h('span', { className: 'dsh-cpm-file-copy' }, h('strong', null, item.name), h('span', null, kind === 'folder' ? '文件夹' : `${fileTypeLabel(item)}  ${fileSize(item.size)}`)))
        })),
        fileOpen === null ? null : h('div', { className: 'dsh-cpm-overlay', onMouseDown: event => { if (event.target === event.currentTarget) { setPreviewBox(null); setFileOpen(null) } } },
          h('div', { className: 'dsh-cpm-dialog dsh-cpm-preview-dialog', style: { left: shownPreview.x, top: shownPreview.y, width: shownPreview.w, height: shownPreview.h } },
            ['n', 's', 'e', 'w', 'nw', 'ne', 'sw', 'se'].map(edge => h('div', { key: edge, className: `dsh-cpm-edge ${edge}`, onPointerDown: event => { beginPreviewGesture(event, edge) } })),
            h('div', { className: 'dsh-cpm-detail-head', onPointerDown: event => { beginPreviewGesture(event, 'move') } }, h('h3', { style: { margin: 0 } }, fileOpen.name),
              h('button', { type: 'button', className: 'dsh-cpm-icon', title: '下载', 'aria-label': '下载', onClick: () => { void fetch(`${API_URL}?fileId=${encodeURIComponent(fileOpen.id)}&download=1`, { credentials: 'same-origin' }).then(response => response.blob()).then(blob => { const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = fileOpen.name; link.click(); URL.revokeObjectURL(url) }) } }, h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: '#4e5969', strokeWidth: 2, 'aria-hidden': 'true' }, h('path', { d: 'M12 4v11M7 11l5 5 5-5M5 20h14' }))),
              h('button', { type: 'button', className: 'dsh-cpm-icon', title: '删除', 'aria-label': '删除', onClick: () => { void call(ctx, { action: 'delete-file', id: fileOpen.id }).then(() => { setFileOpen(null); return loadFiles() }) } }, h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: '#f53f3f', strokeWidth: 2, 'aria-hidden': 'true' }, h('path', { d: 'M4 7h16M9 7V5h6v2M7 7l1 13h8l1-13' }))),
              h('button', { type: 'button', className: 'dsh-cpm-icon', onClick: () => { setPreviewBox(null); setFileOpen(null) } }, '×')),
            h('p', { className: 'dsh-cpm-preview-meta' }, [fileTypeLabel(fileOpen), fileSize(fileOpen.size), fileOpen.createdAt ? new Date(fileOpen.createdAt).toLocaleString() : '—'].join('  ')),
            h('div', { className: 'dsh-cpm-preview' }, h(FilePreview, { id: fileOpen.id, kind: previewKind(fileOpen), name: fileOpen.name })))),
        folderOpen ? h('div', { className: 'dsh-cpm-overlay' }, h('form', { className: 'dsh-cpm-dialog', onSubmit: event => { event.preventDefault(); void call(ctx, { action: 'create-folder', name: folderName.trim(), parentId: fileParent }).then(() => { setFolderOpen(false); return loadFiles() }) } },
          h('h2', null, '新建文件夹'),
          h('div', { className: 'dsh-cpm-body' }, h('label', { className: 'dsh-cpm-field' }, h('span', null, '名称'), h('input', { className: 'dsh-cpm-folder-input', value: folderName, autoFocus: true, onChange: event => { setFolderName(event.target.value) } }))),
          h('div', { className: 'dsh-cpm-dialog-foot' }, h('div', { className: 'dsh-cpm-dialog-actions' },
            h('button', { type: 'button', className: 'dsh-cpm-btn', onClick: () => { setFolderOpen(false) } }, '取消'),
            h('button', { type: 'submit', className: 'dsh-cpm-btn dsh-cpm-primary', disabled: folderName.trim() === '' }, '确定'))))) : null,
        uploadDialog)
      return h('div', { className: 'dsh-cpm' },
        h('style', null, PAGE_CSS),
        h('header', { className: 'dsh-cpm-head' }, h('h1', null, '资源管理')),
        h('div', { className: 'dsh-cpm-tabs' },
          h('span', { className: 'dsh-cpm-tab-slider', style: { transform: `translateX(${Math.max(0, ['resources', 'containers', 'files'].indexOf(tab)) * 100}%)` } }),
          [['resources', '算力资源管理'], ['containers', '镜像仓库'], ['files', '文件仓库']].map(([id, label]) => h('button', {
            key: id, type: 'button', className: 'dsh-cpm-tab', 'data-active': tab === id ? 'true' : 'false',
            onClick: () => { setTab(id); setPage(1); setScreen('list') },
          }, label))),
        screen !== 'list' && tab === 'resources' ? null : h('div', { className: 'dsh-cpm-toolbar', 'data-tab': tab },
          tab === 'resources' ? h('div', { className: 'dsh-cpm-summary' },
            [['节点', String(resources.length), ''], ['正常', String(counts.normal), '正常'], ['异常', String(counts.error), '异常'], ['启动中', String(counts.starting), '启动中']]
              .concat(Object.keys(archCounts).map(name => [name, String(archCounts[name]), '']))
              .concat([['平均 CPU', pct(average('cpu')), ''], ['平均内存', pct(average('mem')), ''], ['平均存储', pct(average('disk')), '']])
              .map(([label, value, kind]) => h('span', { key: label, 'data-kind': kind }, label, ' ', h('b', null, value)))) : null,
          tab === 'files' ? h('div', { className: 'dsh-cpm-file-tools' },
            h('form', { className: 'dsh-cpm-search', onSubmit: event => { event.preventDefault() } },
              h('input', { value: keyword, placeholder: '输入关键词', 'aria-label': '搜索', onChange: event => { setKeyword(event.target.value) } }),
              h('button', { type: 'submit', className: 'dsh-cpm-btn' }, '搜索')),
            h('button', { type: 'button', className: 'dsh-cpm-choice', 'data-active': fileView === 'all' ? 'true' : 'false', onClick: () => { setFileView('all') } }, '全部展示'),
            h('button', { type: 'button', className: 'dsh-cpm-choice', 'data-active': fileView === 'files' ? 'true' : 'false', onClick: () => { setFileView('files') } }, '文件展示'),
            h(RoundMenu, { className: 'dsh-cpm-sort', value: fileType, options: [['all', '全部类型'], ['image', '图片'], ['video', '视频'], ['doc', '文档'], ['other', '其他']].map(([id, label]) => ({ id, label })), onChange: setFileType })) : h('form', { className: 'dsh-cpm-search', onSubmit: event => { event.preventDefault(); setQuery(keyword.trim()); setPage(1) } },
            h('input', { value: keyword, placeholder: '输入关键词', 'aria-label': '搜索', onChange: event => { setKeyword(event.target.value) } }),
            h('button', { type: 'submit', className: 'dsh-cpm-btn' }, '搜索')),
          tab === 'files' ? null : h('button', { type: 'button', className: 'dsh-cpm-btn', onClick: () => { void load() } }, '刷新'),
          tab === 'containers' && registryError !== '' ? h('span', { className: 'dsh-cpm-error' }, registryError) : null,
          tab === 'resources' ? h('button', { type: 'button', className: 'dsh-cpm-btn dsh-cpm-primary', onClick: () => { openResource(null) } }, '添加算力资源') : null,
          tab === 'containers' ? h('button', { type: 'button', className: 'dsh-cpm-btn dsh-cpm-primary', onClick: () => { openContainer(null) } }, '新建镜像') : null,
          tab === 'files' ? h('button', { type: 'button', className: 'dsh-cpm-btn', onClick: () => { void loadFiles() } }, '刷新') : null,
          tab === 'files' ? h('button', { type: 'button', className: 'dsh-cpm-btn', onClick: () => { setFolderName(''); setFolderOpen(true) } }, '新建文件夹') : null,
          tab === 'files' ? h('button', { type: 'button', className: 'dsh-cpm-btn dsh-cpm-primary', onClick: () => { setUploadList([]); setUploadProgress(null); setUploadOpen(true) } }, '上传文件') : null),
        h('div', { className: 'dsh-cpm-main' },
          status === 'loading' ? h('p', { className: 'dsh-cpm-empty' }, '加载中…')
            : status === 'error' ? h('p', { className: 'dsh-cpm-empty' }, error)
              : tab === 'files' ? fileBoard
              : screen !== 'list' && tab === 'resources' && focus ? (screen === 'instances' ? instanceView(focus) : detailView(focus))
                : visible.length === 0 ? h('div', { className: 'dsh-cpm-empty' }, tab === 'containers' ? (registryError || '镜像仓库里还没有镜像') : '暂无算力资源')
                  : cards),
        tab === 'files' ? h('footer', { className: 'dsh-cpm-foot' },
          h('span', { style: { marginRight: 'auto' } }, `文件数 ${fileCount}`),
          h(RoundMenu, { up: true, value: String(filePageSize), options: [100, 200, 500].map(size => ({ id: String(size), label: `${size} 条/页` })), onChange: id => { setFilePageSize(Number(id)); setFilePage(1) } }),
          h('button', { type: 'button', className: 'dsh-cpm-btn', disabled: fileCurrent <= 1, onClick: () => { setFilePage(fileCurrent - 1) } }, '<'),
          h('span', null, `${fileCurrent} / ${filePages}`),
          h('button', { type: 'button', className: 'dsh-cpm-btn', disabled: fileCurrent >= filePages, onClick: () => { setFilePage(fileCurrent + 1) } }, '>')) : screen !== 'list' ? null : h('footer', { className: 'dsh-cpm-foot' },
          h('span', { style: { marginRight: 'auto' } }, `共 ${list.length} 条`),
          h(RoundMenu, { up: true, value: String(pageSize), options: [12, 24, 48].map(size => ({ id: String(size), label: `${size} 条/页` })), onChange: id => { setPageSize(Number(id)); setPage(1) } }),
          h('button', { type: 'button', className: 'dsh-cpm-btn', disabled: current <= 1, onClick: () => { setPage(current - 1) } }, '<'),
          h('span', null, `${current} / ${pages}`),
          h('button', { type: 'button', className: 'dsh-cpm-btn', disabled: current >= pages, onClick: () => { setPage(current + 1) } }, '>')),
        dialogNode,
        debugNode)
    }

    function ServerCard(props) {
      const { form } = props
      const snapshot = useSyncExternalStore(listener => form.subscribe(listener), () => form.getSnapshot(), () => form.getSnapshot())
      const [draft, setDraft] = useState({ host: '127.0.0.1', port: '8080', https: false })
      const [token, setToken] = useState('')
      const [dirty, setDirty] = useState(false)
      const [state, setState] = useState('idle')
      const revision = useRef(null)
      useEffect(() => {
        if (snapshot.status !== 'ready' || dirty) return
        const server = snapshot.value && snapshot.value.server ? snapshot.value.server : {}
        setDraft({
          host: server.host ? String(server.host) : '127.0.0.1',
          port: server.port === undefined ? '8080' : String(server.port),
          https: server.https === true,
        })
        setToken('')
        revision.current = snapshot.revision
      }, [snapshot.status, snapshot.revision])
      if (snapshot.status !== 'ready') return null
      const port = Number(draft.port)
      const invalid = draft.host.trim() === '' || !Number.isInteger(port) || port < 1 || port > 65535
      const save = async () => {
        if (invalid) return
        const ops = [
          { op: 'set', path: ['server', 'host'], value: draft.host.trim() },
          { op: 'set', path: ['server', 'port'], value: port },
          { op: 'set', path: ['server', 'https'], value: draft.https },
        ]
        if (token.trim() !== '') ops.push({ op: 'set', path: ['server', 'token'], value: token.trim() })
        setState('saving')
        try {
          const accepted = await form.mutate(ops, revision.current ?? snapshot.revision)
          setState(accepted ? 'saved' : 'failed')
          if (accepted) { setDirty(false); setToken('') }
        } catch (_failure) { setState('failed') }
      }
      return h('section', { className: 'dsh-cpm-config' },
        h('style', null, PAGE_CSS),
        h('h2', null, '容器服务器'),
        h('div', { className: 'dsh-cpm-config-grid' },
          h('label', { className: 'dsh-cpm-field' }, h('span', null, '地址'), h('input', { className: 'dsh-cpm-input', value: draft.host, spellCheck: false, onChange: event => { setDraft({ ...draft, host: event.target.value }); setDirty(true); setState('idle') } })),
          h('label', { className: 'dsh-cpm-field' }, h('span', null, '端口'), h('input', { className: 'dsh-cpm-input', value: draft.port, inputMode: 'numeric', onChange: event => { setDraft({ ...draft, port: event.target.value }); setDirty(true); setState('idle') } }))),
        h('label', { className: 'dsh-cpm-check' }, h('input', { type: 'checkbox', checked: draft.https, onChange: event => { setDraft({ ...draft, https: event.target.checked }); setDirty(true); setState('idle') } }), '使用 HTTPS'),
        h('label', { className: 'dsh-cpm-field' }, h('span', null, '访问令牌'), h('input', { className: 'dsh-cpm-input', type: 'password', value: token, placeholder: '留空则不修改', autoComplete: 'new-password', onChange: event => { setToken(event.target.value); setDirty(true); setState('idle') } })),
        h('div', null,
          h('button', { type: 'button', className: 'dsh-cpm-btn dsh-cpm-primary', disabled: invalid || state === 'saving' || !snapshot.writable || !dirty, onClick: () => { void save() } }, state === 'saving' ? '保存中…' : '保存'),
          state === 'saved' ? h('span', { style: { marginLeft: '8px', color: '#00b42a' } }, '已保存') : null,
          state === 'failed' || (dirty && invalid) ? h('span', { className: 'dsh-cpm-error', style: { marginLeft: '8px' } }, '请填写地址和 1–65535 的端口') : null))
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, COPY), 'dsh-cpm: dictionaries')
      const t = ctx.locale.bind(NS)
      const form = ctx.configForms.get('cpm')
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 45,
        locale: NS,
        label: () => t('panel'),
      }, ({ size = 16 }) => h('svg', { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
        h('rect', { x: 2, y: 3, width: 12, height: 4, rx: 1, stroke: 'currentColor' }),
        h('rect', { x: 2, y: 9, width: 12, height: 4, rx: 1, stroke: 'currentColor' }))))
      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: PANEL_ID,
        locale: NS,
        inject: () => ({ ctx }),
      }, CpmPage))
      ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
        name: 'plugins.bundle.config',
        key: 'dsh-cpm',
        locale: NS,
        inject: () => ({ form }),
      }, ServerCard))
    }

    return { inject: ['slots', 'locale', 'configForms'], apply }
  },
})
