import fs from 'node:fs';
import path from 'node:path';

const input = path.resolve('examples/fromoldserver/all_surveys_schema.csv');
const outputDir = path.resolve('examples/fromoldserver/converted');
const PAGE_SIZE = 30;

function parseCsv(source) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (quoted) {
      if (ch === '"' && source[i + 1] === '"') { field += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = ''; }
    else field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  const header = rows.shift();
  return rows.filter(r => r.some(Boolean)).map(r => Object.fromEntries(header.map((key, i) => [key, r[i] ?? ''])));
}

function parseBlocks(value) {
  // Formbricks exports `blocks` as `{\"<JSON block>\",\"<JSON block>\"}`.
  // The export is not valid JSON when a block contains escaped editor markup, so
  // split the quoted keys at the only top-level delimiter and decode each key.
  const source = value.trim();
  const result = [];
  let i = source[0] === '{' ? 1 : 0;
  while (i < source.length) {
    while (/[\s,]/.test(source[i] ?? '')) i += 1;
    if (source[i] === '}') break;
    if (source[i] !== '"') throw new Error('invalid Formbricks blocks export');
    const start = i;
    i += 1;
    let escaped = false;
    for (; i < source.length; i += 1) {
      const ch = source[i];
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') break;
    }
    const encoded = source.slice(start, i + 1);
    result.push(JSON.parse(JSON.parse(encoded)));
    i += 1;
  }
  return result;
}

function text(value) {
  return String(value ?? '')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n').trim();
}

function scaleLabels(min, max, lower, upper) {
  const labels = [lower, ...Array.from({ length: max - min - 1 }, (_, i) => String(min + i + 1)), upper];
  return labels;
}

function maxLength(element) {
  const rules = element.validation?.rules ?? [];
  const maxRule = rules.find(rule => rule.type === 'maxLength' && Number.isInteger(rule.params?.max));
  return Math.max(1, Math.min(4000, maxRule?.params?.max ?? 200));
}

function isPersonalText(title) {
  // The questionnaire contract intentionally permits free text only for
  // personal fields.  Keep the common identifier fields from the old server;
  // report other open-text prompts instead of silently changing their meaning.
  return /(\u59d3\u540d|\u540d\u5b57|\u6635\u79f0|\u7535\u8bdd|\u624b\u673a|\u8054\u7cfb\u65b9\u5f0f|\u90ae\u7bb1|\u90ae\u4ef6|\u95ee\u5377\u7f16\u53f7|\u7f16\u53f7|\u53d7\u8bd5\u8005|\u88ab\u8bd5|name|phone|mobile|email|participant|subject|id)/i.test(title);
}

function questionFromElement(element, index) {
  const id = `q_${String(index + 1).padStart(3, '0')}_${element.id}`;
  const title = text(element.headline?.default) || '\u8865\u5145\u8bf4\u660e\uff08\u53ef\u9009\uff09';
  const required = element.required !== false;
  if (element.type === 'openText') {
    if (!isPersonalText(title)) return { skipped: { id: element.id, type: element.type, title, reason: 'NON_PERSONAL_TEXT_NOT_SUPPORTED' } };
    return { id, type: 'text', title, required, input_purpose: 'personal', max_length: maxLength(element) };
  }
  if (element.type === 'multipleChoiceSingle') {
    const choices = (element.choices ?? []).map(choice => text(choice.label?.default)).filter(Boolean);
    if (choices.length >= 2 && new Set(choices).size === choices.length) {
      return { id, type: 'single', title, required, choices };
    }
    return { skipped: { id: element.id, type: element.type, title, reason: 'INVALID_CHOICE_SET' } };
  }
  if (element.type === 'rating') {
    const min = 1;
    const max = Number.isInteger(element.range) ? element.range : 5;
    if (max < 2 || max > 20) return { skipped: { id: element.id, type: element.type, title, reason: 'INVALID_RATING_RANGE' } };
    const lower = text(element.lowerLabel?.default) || '最低';
    const upper = text(element.upperLabel?.default) || '最高';
    return { id, type: 'scale', title, required, min, max, min_label: lower, max_label: upper, labels: scaleLabels(min, max, lower, upper) };
  }
  return { skipped: { id: element.id, type: element.type, title, reason: 'UNSUPPORTED_ELEMENT_TYPE' } };
}

function canonicalQuestions(row) {
  const questions = [];
  const skipped = [];
  for (const block of parseBlocks(row.blocks)) for (const element of block.elements ?? []) {
    const q = questionFromElement(element, questions.length);
    if (q?.skipped) skipped.push(q.skipped);
    else if (q) questions.push(q);
  }
  return { questions, skipped };
}

function makeSurvey(row, questions) {
  const pages = [];
  for (let start = 0, pageNo = 1; start < questions.length; start += PAGE_SIZE, pageNo += 1) {
    pages.push({
      id: `page_${String(pageNo).padStart(2, '0')}`,
      title: `${text(row.name)}��\u7b2c ${pageNo} \u9875��`,
      instruction: '请根据你的实际情况作答。每页提交后继续。',
      questions: questions.slice(start, start + PAGE_SIZE),
    });
  }
  return {
    schema: 'questionnaire-v1',
    title: text(row.name),
    background: '#e5e5e5',
    orientation: 'portrait',
    consent: {
      title: '\u77e5\u60c5\u540c\u610f',
      text: '这份问卷由旧 Formbricks 问卷转换而来。请阅读题目并根据你的实际情况作答。你可以随时停止参与；提交后答案会保存到本项目的数据记录中。',
    },
    ending: { title: '感谢参与', text: '你的答案已保存。现在可以关闭页面。' },
    pages,
  };
}

const rows = parseCsv(fs.readFileSync(input, 'utf8').replace(/^\uFEFF/, ''));
const seen = new Map();
const surveys = [];
const rejected = [];
for (const row of rows) {
  const { questions, skipped } = canonicalQuestions(row);
  if (!questions.length) {
    rejected.push({ id: row.id, name: text(row.name), source_element_count: skipped.length, skipped, reason: 'NO_SUPPORTED_QUESTIONS' });
    continue;
  }
  const signature = JSON.stringify(questions.map(({ id: _id, ...q }) => q));
  if (seen.has(signature)) continue;
  seen.set(signature, row.id);
  surveys.push({ row, questions, skipped });
}

fs.mkdirSync(outputDir, { recursive: true });
// Remove files produced by an earlier conversion so rejected or deduplicated
// surveys cannot remain in the import directory and look current.
const previousManifestPath = path.join(outputDir, 'manifest.json');
if (fs.existsSync(previousManifestPath)) {
  try {
    const previous = JSON.parse(fs.readFileSync(previousManifestPath, 'utf8').replace(/^\uFEFF/, ''));
    for (const item of [...(previous.kept ?? []), ...(previous.rejected ?? [])]) {
      const file = item.file ?? (item.id ? `${item.id}.json` : null);
      if (file) fs.rmSync(path.join(outputDir, file), { force: true });
    }
  } catch { /* regenerate the manifest below */ }
}
const manifest = { source: path.relative(process.cwd(), input).replaceAll('\\', '/'), kept: [], duplicates: [], rejected };
const firstBySignature = new Map();
for (const row of rows) {
  const { questions } = canonicalQuestions(row);
  const signature = JSON.stringify(questions.map(({ id: _id, ...q }) => q));
  if (!firstBySignature.has(signature)) firstBySignature.set(signature, row.id);
  else manifest.duplicates.push({ id: row.id, duplicate_of: firstBySignature.get(signature), name: text(row.name) });
}
for (const { row, questions, skipped } of surveys) {
  const filename = `${row.id}.json`;
  fs.writeFileSync(path.join(outputDir, filename), `${JSON.stringify(makeSurvey(row, questions), null, 2)}\n`);
  manifest.kept.push({ id: row.id, name: text(row.name), file: filename, source_element_count: questions.length + skipped.length, question_count: questions.length, skipped });
}
fs.writeFileSync(path.join(outputDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`converted ${manifest.kept.length} surveys; removed ${manifest.duplicates.length} duplicates`);
