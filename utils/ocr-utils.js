// utils/ocr-utils.js - Shared text cleanup, structured entity extraction, and table reconstruction

(() => {
  const OcrUtils = {};

  /**
   * Strip common icon/badge OCR artifacts from a line while preserving real punctuation & prices.
   */
  OcrUtils.cleanLineText = function (text) {
    if (!text) return "";
    let s = text.trim();
    // Remove leading isolated noise clusters like "* Kx ", "( (4 ", "M " only when clearly symbol noise
    s = s.replace(/^[|¦\\/<>~`^_*•·]+\s+/g, "");
    // Remove trailing orphan symbol artifacts like " @)", " ] ]", " (", " ;", " \"
    s = s.replace(/\s+(?:[@©®™]\)|[\]\)}]+|[\(\[{]+|[\\/|;:])$/g, "");
    // Remove trailing solitary unmatched bracket after space, e.g. "mitmaxim (714) ("
    s = s.replace(/\s+[\(\[\{]$/g, "");
    // Collapse multiple spaces
    s = s.replace(/\s{2,}/g, " ").trim();
    return s;
  };

  /**
   * Check whether a line is pure UI icon/punctuation garbage (e.g., "( (4", "bà wi] ]", "] ]").
   */
  OcrUtils.isLikelyNoiseLine = function (words, smartFilter = true) {
    if (!words || !words.length) return true;
    const joined = words.map((w) => w.text).join(" ").trim();
    if (!joined) return true;

    const avgConf = words.reduce((sum, w) => sum + (w.confidence || 0), 0) / words.length;
    const alnumCount = (joined.match(/[\p{L}\p{N}]/gu) || []).length;

    // Pure punctuation/brackets with no letters or digits
    if (alnumCount === 0) return true;

    if (!smartFilter) return false;

    // Very short gibberish with low confidence (common for stars, hearts, info icons)
    if (joined.length <= 3 && avgConf < 58 && !/^\d+([.,]\d+)?%?$/.test(joined)) {
      return true;
    }

    // High proportion of brackets/symbols + low confidence (e.g. "bà wi] ]", "* Kx", "@)")
    const symbolCount = (joined.match(/[\[\]\(\)\{\}\\<>~`^_*|@]/g) || []).length;
    if (symbolCount >= 2 && avgConf < 68 && symbolCount / joined.length > 0.25) {
      return true;
    }

    // Multiple tiny low-confidence fragments on one line (e.g. "( (4")
    if (words.length >= 2 && words.every((w) => w.text.length <= 2) && avgConf < 65) {
      return true;
    }

    return false;
  };

  /**
   * Extract structured entities (emails, URLs, phone numbers, prices) from OCR text.
   */
  OcrUtils.extractEntities = function (text) {
    if (!text) return { emails: [], urls: [], phones: [], prices: [] };
    const uniq = (arr) => [...new Set(arr.map((s) => s.trim()).filter(Boolean))];

    const emails = uniq(text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || []);
    const urls = uniq(text.match(/\bhttps?:\/\/[^\s<>"{}|\\^`[\]]+/gi) || []);
    const prices = uniq(
      text.match(
        /(?:[$€£¥₫]\s?\d[\d.,]*(?:\s?[kKmMbB])?|\d[\d.,]+\s?(?:VND|USD|EUR|GBP|JPY|KRW|đ|vnđ))/gi
      ) || []
    );
    const phones = uniq(
      (text.match(/(?:\+?\d{1,3}[\s.-]?)?(?:\(?\d{2,4}\)?[\s.-]?){2,4}\d{2,4}/g) || []).filter(
        (m) => {
          const digits = m.replace(/\D/g, "");
          return digits.length >= 8 && digits.length <= 15 && !/^\d{1,3}(?:[.,]\d{3})+$/.test(m.trim());
        }
      )
    );

    return { emails, urls, phones, prices };
  };

  /**
   * Reconstruct rows & columns from OCR word bounding boxes.
   * Clusters words by vertical center into rows, then detects column gaps.
   */
  OcrUtils.extractTableFromLines = function (lines) {
    if (!lines || !lines.length) {
      return { isTable: false, rows: [], tsv: "", markdown: "", csv: "" };
    }

    const allWords = [];
    for (const line of lines) {
      for (const w of line.words || []) {
        if (!w.bbox) continue;
        allWords.push({
          text: w.text,
          x0: w.bbox.x0,
          y0: w.bbox.y0,
          x1: w.bbox.x1,
          y1: w.bbox.y1,
          cy: (w.bbox.y0 + w.bbox.y1) / 2,
          h: Math.max(8, w.bbox.y1 - w.bbox.y0)
        });
      }
    }
    if (!allWords.length) {
      return { isTable: false, rows: [], tsv: "", markdown: "", csv: "" };
    }

    // Sort top-to-bottom, then left-to-right
    allWords.sort((a, b) => a.cy - b.cy || a.x0 - b.x0);

    // Group words into visual rows
    const visualRows = [];
    for (const w of allWords) {
      const targetRow = visualRows.find((r) => Math.abs(r.cy - w.cy) <= Math.max(r.avgH, w.h) * 0.55);
      if (targetRow) {
        targetRow.words.push(w);
        targetRow.cy = targetRow.words.reduce((s, item) => s + item.cy, 0) / targetRow.words.length;
        targetRow.avgH = targetRow.words.reduce((s, item) => s + item.h, 0) / targetRow.words.length;
      } else {
        visualRows.push({ cy: w.cy, avgH: w.h, words: [w] });
      }
    }

    // Split each row into cells when horizontal gap exceeds ~1.6x typical word height
    const cellRows = visualRows.map((r) => {
      r.words.sort((a, b) => a.x0 - b.x0);
      const cells = [];
      let cur = { x0: r.words[0].x0, x1: r.words[0].x1, parts: [r.words[0].text] };
      for (let i = 1; i < r.words.length; i++) {
        const prev = r.words[i - 1];
        const w = r.words[i];
        const gap = w.x0 - prev.x1;
        const threshold = Math.max(r.avgH * 1.4, 18);
        if (gap > threshold) {
          cells.push({ x0: cur.x0, x1: cur.x1, text: cur.parts.join(" ") });
          cur = { x0: w.x0, x1: w.x1, parts: [w.text] };
        } else {
          cur.x1 = Math.max(cur.x1, w.x1);
          cur.parts.push(w.text);
        }
      }
      cells.push({ x0: cur.x0, x1: cur.x1, text: cur.parts.join(" ") });
      return cells;
    });

    // Align cells onto global column centers if multiple rows have >1 cell
    const multiCellRows = cellRows.filter((r) => r.length > 1).length;
    const isTable = multiCellRows >= 2;

    const colAnchors = [];
    for (const row of cellRows) {
      for (const cell of row) {
        const match = colAnchors.find((c) => Math.abs(c.x0 - cell.x0) < 35);
        if (match) {
          match.samples.push(cell.x0);
          match.x0 = match.samples.reduce((a, b) => a + b, 0) / match.samples.length;
        } else {
          colAnchors.push({ x0: cell.x0, samples: [cell.x0] });
        }
      }
    }
    colAnchors.sort((a, b) => a.x0 - b.x0);

    const numCols = Math.max(1, colAnchors.length);
    const grid = cellRows.map((row) => {
      if (!isTable || numCols === 1) return row.map((c) => c.text);
      const out = new Array(numCols).fill("");
      for (const cell of row) {
        let bestIdx = 0;
        let bestDist = Infinity;
        for (let i = 0; i < numCols; i++) {
          const d = Math.abs(colAnchors[i].x0 - cell.x0);
          if (d < bestDist) {
            bestDist = d;
            bestIdx = i;
          }
        }
        out[bestIdx] = out[bestIdx] ? `${out[bestIdx]} ${cell.text}` : cell.text;
      }
      return out;
    });

    // Normalize width
    const maxCols = Math.max(...grid.map((r) => r.length), 1);
    const normalized = grid.map((r) => {
      const copy = [...r];
      while (copy.length < maxCols) copy.push("");
      return copy;
    });

    const tsv = normalized.map((r) => r.join("\t")).join("\n");
    const csv = normalized.map((r) => r.map(OcrUtils.escapeCsvCell).join(",")).join("\n");

    let markdown = "";
    if (normalized.length >= 1) {
      const header = `| ${normalized[0].map((c) => c.replace(/\|/g, "\\|")).join(" | ")} |`;
      const sep = `| ${normalized[0].map(() => "---").join(" | ")} |`;
      const body = normalized
        .slice(1)
        .map((r) => `| ${r.map((c) => c.replace(/\|/g, "\\|")).join(" | ")} |`)
        .join("\n");
      markdown = body ? `${header}\n${sep}\n${body}` : `${header}\n${sep}`;
    }

    return { isTable, rows: normalized, tsv, markdown, csv };
  };

  OcrUtils.escapeCsvCell = function (val) {
    const s = String(val ?? "");
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };

  window.OcrUtils = OcrUtils;
})();
