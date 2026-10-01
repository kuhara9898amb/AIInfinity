const pptxgen = require('pptxgenjs');
const path = require('path');
const IMG = path.join(__dirname, 'lp/jpg');
const img = (f) => path.join(IMG, f === 'logo.png' ? f : f.replace(/\.png$/, '.jpg'));

const pres = new pptxgen();
pres.layout = 'LAYOUT_WIDE'; // 13.333 x 7.5
pres.title = 'HACHINOS サービスご紹介';
const W = 13.333, H = 7.5;
const Y = 'FFD400', YS = 'FFF8D6', K = '111111', T = '222222', S = '5B5B5B', G = 'F5F5F2', WH = 'FFFFFF';
const F = 'Noto Sans JP';

const txt = (s, text, o) => s.addText(text, Object.assign({ isTextBox: true, fontFace: F, color: T, margin: 0, valign: 'top' }, o));
const card = (s, x, y, w, h, o = {}) => s.addShape(pres.shapes.ROUNDED_RECTANGLE, Object.assign({ x, y, w, h, rectRadius: 0.12, fill: { color: WH }, line: { color: Y, width: 2 } }, o));
const hex = (s, x, y, w, o = {}) => s.addShape(pres.shapes.HEXAGON, Object.assign({ x, y, w, h: w * 0.866, fill: { color: Y } , line: { color: Y, width: 0 } }, o));
const hexLine = (s, x, y, w) => hex(s, x, y, w, { fill: { type: 'none' }, line: { color: Y, width: 3 } });

let pageNo = 0;
function base(bg = WH, opts = {}) {
  const s = pres.addSlide();
  s.background = { color: bg };
  pageNo++;
  if (pageNo > 1) {
    if (!opts.noLogo) s.addImage({ path: img('logo.png'), x: W - 0.5 - 1.3, y: 0.32, w: 1.3, h: 1.3 * 119 / 486 });
    txt(s, String(pageNo), { x: W - 1.0, y: H - 0.42, w: 0.5, h: 0.25, fontSize: 10, color: opts.light ? 'DDDDDD' : S, align: 'right' });
  }
  return s;
}
function heading(s, en, ja, o = {}) {
  const x = o.x ?? 0.6, y = o.y ?? 0.45, w = o.w ?? 10;
  s.addShape(pres.shapes.RECTANGLE, { x, y, w: 0.4, h: 0.06, fill: { color: o.dash || Y }, line: { type: 'none' } });
  txt(s, en, { x, y: y + 0.14, w: 4, h: 0.3, fontSize: 11, bold: true, charSpacing: 3, color: o.enColor || K });
  txt(s, ja, { x, y: y + 0.48, w, h: 0.75, fontSize: o.size || 30, bold: true, color: o.color || K });
}

// ---------- 1. Cover ----------
{
  const s = base(WH);
  s.addImage({ path: img('logo.png'), x: 0.6, y: 0.3, w: 1.9, h: 1.9 * 119 / 486 });
  txt(s, 'サービスご紹介資料', { x: W - 4.6, y: 0.36, w: 4.0, h: 0.4, fontSize: 14, bold: true, align: 'right', color: K });
  const hh = W * 839 / 1875;
  s.addImage({ path: img('hero.png'), x: 0, y: 0.95, w: W, h: hh });
  txt(s, '株式会社HornetVentures　｜　info@hornet-v.com　｜　03-4400-2790', { x: 0.6, y: H - 0.5, w: 9, h: 0.3, fontSize: 11, color: S });
}

// ---------- 2. Problem ----------
{
  const s = base(G);
  heading(s, 'PROBLEM', '防犯カメラ、「録画するだけ」になっていませんか？');
  const items = [
    ['p-record.png', '映像は何かあった時に\n見返すだけ'],
    ['p-unknown.png', 'どんなお客様が\n来ているか\n数字でわからない'],
    ['p-route.png', '売場やレイアウトの\n効果を検証できない'],
    ['p-late.png', '万引き・転倒・侵入に\n気づくのが\n遅れる'],
    ['p-staff.png', '人手不足で\n見回りが追いつかない'],
  ];
  const cw = 2.25, gap = 0.2, x0 = (W - (cw * 5 + gap * 4)) / 2, y0 = 2.05, ch = 3.4;
  items.forEach(([f, t], i) => {
    const x = x0 + i * (cw + gap);
    card(s, x, y0, cw, ch);
    s.addImage({ path: img(f), x: x + (cw - 1.6) / 2, y: y0 + 0.25, w: 1.6, h: 1.6 });
    txt(s, t, { x: x + 0.08, y: y0 + 2.0, w: cw - 0.16, h: 1.2, fontSize: 13, bold: true, align: 'center', valign: 'middle', lineSpacingMultiple: 1.3 });
  });
  txt(s, [
    { text: 'その映像、' }, { text: '売上と現場改善のデータ', options: { bold: true, highlight: Y } }, { text: 'に変えられます。' },
  ], { x: 0.6, y: 5.95, w: W - 1.2, h: 0.6, fontSize: 24, bold: true, align: 'center', valign: 'middle', color: K });
}

// ---------- 3. Solution ----------
{
  const s = base(WH);
  heading(s, 'SOLUTION', 'HACHINOSは、映像を「使えるデータ」に変えるAIです', { w: 11 });
  const items = [
    ['capture.png', '映像取得', '今お使いの防犯カメラの映像を、そのままHACHINOS本体に取り込みます。'],
    ['ai.png', 'AI解析', '施設内の本体でAIが人物の属性・動き・人数・異常を解析します。'],
    ['visual.png', '可視化', '来店客の傾向や動線、混雑をダッシュボードでグラフ・ヒートマップ表示します。'],
    ['notify.png', '現場通知', '侵入・転倒などを検知すると、映像ではなく匿名テキストで現場へお知らせします。'],
  ];
  const cw = 2.85, gap = 0.3, x0 = (W - (cw * 4 + gap * 3)) / 2, y0 = 2.2, ch = 4.4;
  items.forEach(([f, t, d], i) => {
    const x = x0 + i * (cw + gap);
    card(s, x, y0, cw, ch, { line: { color: K, width: 1.5 } });
    s.addImage({ path: img(f), x: x + 0.02, y: y0 + 0.02, w: cw - 0.04, h: (cw - 0.04) * 467 / 700, sizing: { type: 'cover', w: cw - 0.04, h: (cw - 0.04) * 467 / 700 } });
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: x + cw / 2 - 0.35, y: y0 - 0.17, w: 0.7, h: 0.34, rectRadius: 0.17, fill: { color: K }, line: { type: 'none' } });
    txt(s, '0' + (i + 1), { x: x + cw / 2 - 0.35, y: y0 - 0.17, w: 0.7, h: 0.34, fontSize: 12, bold: true, color: Y, align: 'center', valign: 'middle' });
    txt(s, t, { x: x + 0.2, y: y0 + 2.1, w: cw - 0.4, h: 0.5, fontSize: 20, bold: true, align: 'center', color: K });
    txt(s, d, { x: x + 0.25, y: y0 + 2.7, w: cw - 0.5, h: 1.5, fontSize: 13, color: S, lineSpacingMultiple: 1.4 });
    if (i < 3) txt(s, '›', { x: x + cw + 0.02, y: y0 + 1.7, w: 0.26, h: 0.6, fontSize: 30, bold: true, align: 'center', color: K });
  });
}

// ---------- 4. Merit ----------
{
  const s = base(Y);
  heading(s, 'MERIT', '導入メリット', { dash: K });
  const items = [
    ['m-camera-keep-v2.png', 'カメラの買い替え不要', '既存の防犯カメラをそのまま活用。追加するのは本体だけです。'],
    ['m-local-v2.png', '映像は施設内で処理', '映像を外部に送らず、施設内の本体で解析します。'],
    ['m-step-v2.png', '小さく始めて広げられる', '必要な機能・台数から始め、追加アプリで段階的に拡張できます。'],
    ['m-sales-v2.png', 'データで売上改善', '客層・動線・滞在を数字で把握し、売場や人員配置の改善に活かせます。'],
    ['m-labor-v2.png', '見守り・省人化', '異常検知と通知で、少ない人数でも現場の安全を保ちやすくなります。'],
  ];
  const cw = 2.3, gap = 0.2, x0 = (W - (cw * 5 + gap * 4)) / 2, y0 = 2.05, ch = 4.6;
  items.forEach(([f, t, d], i) => {
    const x = x0 + i * (cw + gap);
    card(s, x, y0, cw, ch, { line: { type: 'none' } });
    s.addImage({ path: img(f), x: x + (cw - 1.7) / 2, y: y0 + 0.25, w: 1.7, h: 1.7 });
    txt(s, t, { x: x + 0.06, y: y0 + 2.15, w: cw - 0.12, h: 0.75, fontSize: 13.5, bold: true, align: 'center', valign: 'middle', color: K });
    txt(s, d, { x: x + 0.2, y: y0 + 3.0, w: cw - 0.4, h: 1.4, fontSize: 12, color: S, lineSpacingMultiple: 1.4 });
  });
}

// ---------- 5. Device ----------
{
  const s = base(WH);
  heading(s, 'DEVICE', '既存カメラに、本体を加えるだけ');
  s.addImage({ path: img('hachinos-product-v2.png'), x: 0.6, y: 1.95, w: 5.8, h: 5.8 * 880 / 1100 });
  txt(s, 'HACHINOS本体　※イメージ', { x: 0.6, y: 6.65, w: 5.8, h: 0.3, fontSize: 10, color: S, align: 'center' });
  txt(s, 'カメラ工事を最小限に。\n映像解析はこの1台で。', { x: 7.0, y: 2.2, w: 5.8, h: 1.3, fontSize: 26, bold: true, color: K, lineSpacingMultiple: 1.25 });
  txt(s, 'HACHINOS本体を施設内のネットワークに設置し、既存の防犯カメラ映像を取り込むだけでAI解析を開始できます。カメラの入れ替えや大規模な配線工事を前提としません。',
    { x: 7.0, y: 3.7, w: 5.6, h: 1.2, fontSize: 14, color: T, lineSpacingMultiple: 1.5 });
  const checks = ['既存カメラをそのまま利用（対応可否は事前ヒアリングで確認）', '映像は施設内の本体で処理', 'ネット回線が切れても本体はローカルで稼働'];
  checks.forEach((c, i) => {
    const y = 5.1 + i * 0.5;
    s.addShape(pres.shapes.OVAL, { x: 7.0, y: y + 0.04, w: 0.28, h: 0.28, fill: { color: Y }, line: { type: 'none' } });
    txt(s, '✓', { x: 7.0, y: y + 0.04, w: 0.28, h: 0.28, fontSize: 11, bold: true, align: 'center', valign: 'middle', color: K });
    txt(s, c, { x: 7.45, y, w: 5.5, h: 0.36, fontSize: 13, bold: true, valign: 'middle', color: K });
  });
}

// ---------- 6. System flow ----------
{
  const s = base(G);
  heading(s, 'HOW IT WORKS', '映像は施設内で解析し、結果だけを届けます', { w: 11 });
  const boxes = [
    ['capture.png', '今ある防犯カメラ', '既存カメラの映像を取得'],
    ['hachinos-product-v2.png', 'HACHINOS本体', '施設内で映像をAI解析'],
    ['visual.png', 'ダッシュボード', '来店数・動線・傾向を可視化'],
    ['notify.png', 'スマホへ現場通知', '次の行動を匿名テキストでお知らせ'],
  ];
  const cw = 2.75, gap = 0.45, x0 = (W - (cw * 4 + gap * 3)) / 2, y0 = 2.15, ch = 3.75;
  boxes.forEach(([f, t, d], i) => {
    const x = x0 + i * (cw + gap);
    const hl = i === 1;
    card(s, x, y0, cw, ch, { line: hl ? { color: Y, width: 4 } : { type: 'none' } });
    txt(s, t, { x: x + 0.15, y: y0 + 0.22, w: cw - 0.3, h: 0.45, fontSize: 17, bold: true, align: 'center', color: K });
    const iw = cw - 0.4, ih = iw * (f.startsWith('hachinos') ? 880 / 1100 : 467 / 700);
    s.addImage({ path: img(f), x: x + 0.2, y: y0 + 0.85, w: iw, h: ih });
    txt(s, d, { x: x + 0.2, y: y0 + 2.95, w: cw - 0.4, h: 0.6, fontSize: 13, color: S, align: 'center', valign: 'middle' });
    if (i < 3) txt(s, '→', { x: x + cw, y: y0 + ch / 2 - 0.3, w: gap, h: 0.6, fontSize: 24, bold: true, align: 'center', valign: 'middle', color: K });
  });
  txt(s, '映像は施設内の本体で処理。外部への通知は映像を含まない匿名テキストです。画像・画面はイメージです。',
    { x: 0.6, y: 6.35, w: W - 1.2, h: 0.35, fontSize: 12, color: S, align: 'center' });
}

// ---------- 7. Basic apps ----------
{
  const s = base(WH);
  heading(s, 'BASIC APPS', '基本アプリ（5群）');
  const items = [
    ['b-attr-v2.png', '属性分析／\nリピート検知', '性別・推定年齢を分析。常連のお客様や、登録済みの出入り禁止対象者の来店を検知します。'],
    ['b-flow-v2.png', '動線／滞留分析', '店内の移動経路を動線図で、立ち止まりの多い場所をヒートマップで可視化します。'],
    ['b-count-v2.png', '通行量／\n人数カウント', '入店数・通行量・エリアごとの人数を時間帯別に集計します。'],
    ['b-intrusion-v2.png', '侵入／ラインクロス／\nエリア検知', '立入禁止エリアへの侵入や、指定ラインの通過を検知して通知します。'],
    ['b-safety-v2.png', '転倒／タバコ／\n火災検知', '転倒・喫煙・火災の兆候を検知し、早期対応につなげます。'],
  ];
  // 3 + 2 layout of horizontal cards
  const cw = 3.9, ch = 2.15, gap = 0.25;
  items.forEach(([f, t, d], i) => {
    const row = i < 3 ? 0 : 1;
    const n = row === 0 ? 3 : 2;
    const col = row === 0 ? i : i - 3;
    const x0 = (W - (cw * n + gap * (n - 1))) / 2;
    const x = x0 + col * (cw + gap), y = 2.0 + row * (ch + 0.3);
    card(s, x, y, cw, ch, { fill: { color: G }, line: { type: 'none' } });
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: x + 0.2, y: y + 0.3, w: 1.3, h: 1.3, rectRadius: 0.1, fill: { color: WH }, line: { type: 'none' } });
    s.addImage({ path: img(f), x: x + 0.25, y: y + 0.35, w: 1.2, h: 1.2 });
    txt(s, t, { x: x + 1.7, y: y + 0.28, w: cw - 1.85, h: 0.7, fontSize: 15, bold: true, color: K, valign: 'middle' });
    txt(s, d, { x: x + 1.7, y: y + 1.0, w: cw - 1.85, h: 1.05, fontSize: 11.5, color: S, lineSpacingMultiple: 1.35 });
  });
}

// ---------- 8. Add-on apps ----------
{
  const s = base(WH);
  heading(s, 'ADD-ON APPS', '追加アプリ（10機能）');
  txt(s, '業種や課題に合わせて、必要なアプリだけを追加できます。', { x: 0.6, y: 1.65, w: 8, h: 0.35, fontSize: 14, color: S });
  const items = [
    ['a-theft-v3.png', '万引き・盗難検知'], ['a-crowd-v3.png', '混雑検知'], ['a-layout-v3.png', '売場最適化'],
    ['a-signage-v3.png', 'サイネージ効果測定'], ['a-stock-v3.png', '在庫管理／自動発注'], ['a-menu-v3.png', 'メニュー改善'],
    ['a-table-v3.png', 'テーブル滞在・売上分析'], ['a-gear-v3.png', '作業員装備確認／省人化'], ['a-cargo-v3.png', '荷役時間の計測'],
    ['a-inspect-v3.png', '自動検品／仕分け'],
  ];
  const cw = 2.25, ch = 1.85, gap = 0.2, x0 = (W - (cw * 5 + gap * 4)) / 2;
  items.forEach(([f, t], i) => {
    const r = Math.floor(i / 5), c = i % 5;
    const x = x0 + c * (cw + gap), y = 2.2 + r * (ch + 0.2);
    card(s, x, y, cw, ch);
    s.addImage({ path: img(f), x: x + (cw - 1.05) / 2, y: y + 0.15, w: 1.05, h: 1.05 });
    txt(s, t, { x: x + 0.1, y: y + 1.25, w: cw - 0.2, h: 0.5, fontSize: 12, bold: true, align: 'center', valign: 'middle', color: K });
  });
  // extras strip
  const ex = ['AIチャット', 'POS・天候などと連携', 'ダッシュボード', '匿名テキスト通知・施設内映像処理'];
  txt(s, 'さらに、分析を活かす仕組み', { x: x0, y: 6.3, w: 3.2, h: 0.4, fontSize: 13, bold: true, color: K, valign: 'middle' });
  let ex0 = x0 + 3.2;
  const ews = [1.45, 2.25, 1.6, 3.4];
  ex.forEach((e, i) => {
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: ex0, y: 6.3, w: ews[i], h: 0.4, rectRadius: 0.2, fill: { color: YS }, line: { color: Y, width: 1 } });
    txt(s, e, { x: ex0, y: 6.3, w: ews[i], h: 0.4, fontSize: 11.5, bold: true, align: 'center', valign: 'middle', color: K });
    ex0 += ews[i] + 0.12;
  });
  txt(s, '※一部に開発予定・提供予定の機能を含みます。提供時期や対応範囲はお問い合わせください。', { x: 0.6, y: 6.85, w: 10, h: 0.3, fontSize: 10, color: S });
}

// ---------- 9. Use case overview ----------
const cases = [
  { f: 'case-retail-v2.png', no: '01', name: 'スーパー・小売', tags: ['レジ配置の最適化', '値引き・発注の判断材料', '万引きなどのロス防止'],
    lead: '時間帯ごとの来店数とレジ待ち人数から、レジの開放数や配置を最適化。売場の滞在傾向をもとに、値引きや発注のタイミングを判断しやすくします。',
    pts: [['混雑の先読みでレジ応援を配置', '店前通行量や天候データをもとに、数十分後のレジ混雑を予測。品出し中のスタッフへ応援配置を通知し、長蛇の列による購入断念を減らす判断を支援します。'],
      ['値引き・発注をデータで判断', '惣菜・生鮮売場の通行量や滞留行動を計測。売れ行きと合わせて、売り切りに向けた値引きのタイミングや発注量の見直しに活用します。'],
      ['セルフレジ・高額商品のロス防止', 'セルフレジの長時間停滞や、酒類・米・医薬品などの売場での不審な滞留を検知。スタッフのお声がけにつなげ、未精算や棚卸ロスの防止を支援します。']] },
  { f: 'case-restaurant-v2.png', no: '02', name: '飲食店', tags: ['片付け・案内の迅速化', '追加注文のきっかけづくり', '仕込み・人員配置の計画'],
    lead: '客席ごとの滞在時間や空席を把握し、片付けのタイミングや追加注文のお声がけを支援。混雑時間帯の傾向から、仕込み量やスタッフ配置の計画にも活かせます。',
    pts: [['退店後の片付けをすぐに通知', 'テーブルの空席状態や退店を判定し、スタッフへ片付け（バッシング）を推奨。空席が放置される時間を減らし、次のお客様を案内する判断を支えます。'],
      ['滞在時間に応じた追加注文の提案', 'テーブルごとの滞在時間を計測し、一定時間を過ぎたタイミングで追加オーダーのお伺いを促します。客単価向上と、スムーズな接客・退店案内に活用します。'],
      ['混雑前に仕込み・配置を調整', '雨上がりなどの天候変化や店前通行量の増加から、数十分後の需要を予測。仕込みの追加やスタッフ配置の変更を事前に検討できます。']] },
  { f: 'case-department-v2.png', no: '03', name: '百貨店・商業施設', tags: ['回遊・立ち寄りの分析', 'VIP来店の把握', '催事の効果測定'],
    lead: 'フロア間の回遊ルートや立ち寄りの多い売場を可視化。登録済みのVIPのお客様の来店をいち早く把握し、催事の集客効果も数字で比較できます。',
    pts: [['入口からブランド売場までの回遊を把握', '動線とヒートマップにより、どの入口から入ったお客様が、どのブランドゾーンへ移動したかを可視化。売場間の流入や立ち寄りを配置改善の材料にします。'],
      ['常連・VIPへの接客を支援', 'VIPラウンジや高額品売場で、登録済みの常連・重要顧客の来店を把握。担当者への連絡や、タイミングを逃さない丁寧な接客につなげます。'],
      ['催事・ポップアップの価値を可視化', '期間限定イベントの通行量・滞留時間を測定。レイアウトの改善、出店メーカーへのフィードバック、次回の出店料・賃料交渉の判断材料に活用します。']] },
  { f: 'case-care-v2.png', no: '04', name: '病院・介護施設', tags: ['転倒の早期発見', '侵入・徘徊の検知', '夜間の見守り負担軽減'],
    lead: '廊下や居室付近での転倒、夜間の立入禁止エリアへの侵入を検知し、スタッフへ匿名テキストで通知。限られた人数での見守りを支えます。',
    pts: [['転倒を早期発見し、救護へつなぐ', '待合室や廊下での転倒をリアルタイムに検知し、スタッフへ通知。現場確認や救護を迅速に行うための見守りを支援します。'],
      ['夜間の無断外出・危険エリアを監視', '薬品庫やスタッフルームなどへの侵入、夜間の無断外出につながる境界の横断を検知。ラインクロスのアラートを現場確認につなげます。'],
      ['プライバシーに配慮して見守る', '映像は施設内で処理し、外部への通知は匿名テキストで行います。院内の動線や状況を把握し、夜間巡回・駆けつけの判断を支えます。']] },
  { f: 'case-finance-v2.png', no: '05', name: '金融機関', tags: ['ATM前の通話・滞留検知', '不審行動の把握', '転倒時のフォロー'],
    lead: 'ATM前で携帯電話で通話しながら長く滞留するお客様を検知し、特殊詐欺の被害防止のお声がけにつなげます。不審な行動や店内での転倒時のフォローにも活用できます。',
    pts: [['ATMでの通話・長時間滞留を把握', 'ATM操作前・操作中のスマホ通話姿勢や、不自然な長時間滞留を検知。資料では3分以上を想定し、還付金・振り込め詐欺の兆候に早めにお声がけする用途を示しています。'],
      ['不自然な連続利用の確認を支援', '帽子や深いマスクなどによる顔の遮蔽、不自然な連続滞留・複数回の引き出し行動を確認する材料に。検知結果をもとに、職員が状況確認や対応を判断します。'],
      ['転倒・操作困難をすぐにフォロー', 'ATMコーナーでの転倒や、操作が進まず長く滞留している状況を検知。高齢のお客様などへの案内や救護、無人拠点での現地確認につなげます。']] },
];
{
  const s = base(G);
  heading(s, 'USE CASE', '業種別の活用例');
  txt(s, '既存の映像を、現場の判断と行動へ。サービス資料に基づく、想定されるユースケースです（導入実績ではありません）。', { x: 0.6, y: 1.65, w: 11, h: 0.35, fontSize: 13, color: S });
  const cw = 2.3, gap = 0.2, x0 = (W - (cw * 5 + gap * 4)) / 2, y0 = 2.3, ch = 4.5;
  cases.forEach((c, i) => {
    const x = x0 + i * (cw + gap);
    card(s, x, y0, cw, ch, { line: { type: 'none' } });
    s.addImage({ path: img(c.f), x, y: y0, w: cw, h: cw * 633 / 1000 });
    txt(s, 'CASE ' + c.no, { x: x + 0.2, y: y0 + 1.6, w: 1.5, h: 0.3, fontSize: 10, bold: true, color: S, charSpacing: 2 });
    txt(s, c.name, { x: x + 0.2, y: y0 + 1.9, w: cw - 0.4, h: 0.45, fontSize: 16, bold: true, color: K });
    c.tags.forEach((t, j) => {
      const y = y0 + 2.55 + j * 0.58;
      s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: x + 0.15, y, w: cw - 0.3, h: 0.45, rectRadius: 0.08, fill: { color: YS }, line: { type: 'none' } });
      txt(s, t, { x: x + 0.22, y, w: cw - 0.4, h: 0.45, fontSize: 10, bold: true, color: K, valign: 'middle' });
    });
  });
}

// ---------- 10-14. Case details ----------
cases.forEach((c) => {
  const s = base(WH);
  const iw = 5.2;
  s.addImage({ path: img(c.f), x: 0, y: 0, w: iw, h: H, sizing: { type: 'cover', w: iw, h: H } });
  s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: 0.45, y: 0.45, w: 1.5, h: 0.42, rectRadius: 0.21, fill: { color: Y }, line: { type: 'none' } });
  txt(s, 'CASE ' + c.no, { x: 0.45, y: 0.45, w: 1.5, h: 0.42, fontSize: 13, bold: true, align: 'center', valign: 'middle', color: K, charSpacing: 2 });
  const x = iw + 0.6, w = W - iw - 1.2;
  txt(s, c.name, { x, y: 0.75, w: w - 1.8, h: 0.7, fontSize: 32, bold: true, color: K });
  txt(s, c.lead, { x, y: 1.6, w, h: 0.95, fontSize: 13, color: S, lineSpacingMultiple: 1.45 });
  c.pts.forEach(([t, d], j) => {
    const y = 2.8 + j * 1.45;
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y, w, h: 1.28, rectRadius: 0.1, fill: { color: G }, line: { type: 'none' } });
    hex(s, x + 0.2, y + 0.22, 0.62);
    txt(s, '0' + (j + 1), { x: x + 0.2, y: y + 0.22, w: 0.62, h: 0.54, fontSize: 14, bold: true, align: 'center', valign: 'middle', color: K });
    txt(s, t, { x: x + 1.05, y: y + 0.14, w: w - 1.25, h: 0.4, fontSize: 15, bold: true, color: K, valign: 'middle' });
    txt(s, d, { x: x + 1.05, y: y + 0.55, w: w - 1.25, h: 0.7, fontSize: 11, color: S, lineSpacingMultiple: 1.35 });
  });
  txt(s, '※サービス資料に基づく想定ユースケースです（導入実績ではありません）。', { x, y: 7.08, w: 6.5, h: 0.25, fontSize: 9, color: S });
});

// ---------- 15. ROI ----------
{
  const s = base(WH);
  heading(s, 'ROI', '投資回収の試算例');
  txt(s, '資料の想定価値・初期費用をもとに、月額15,000円／台で再計算した試算例です（金額は税抜）。', { x: 0.6, y: 1.65, w: 11, h: 0.35, fontSize: 13, color: S });
  const hdr = ['業種', '台数', '初期費用', '月額', '月間の想定価値', '月額控除後', '回収目安'];
  const rows = [
    ['小売', '10台', '668,867円', '150,000円', '250,000円', '100,000円', '約6.7ヶ月'],
    ['飲食', '5台', '506,170円', '75,000円', '180,000円', '105,000円', '約4.8ヶ月'],
    ['百貨店', '15台', '1,259,342円', '225,000円', '550,000円', '325,000円', '約3.9ヶ月'],
    ['病院・介護', '10台', '668,867円', '150,000円', '300,000円', '150,000円', '約4.5ヶ月'],
    ['金融', '8台', '668,867円', '120,000円', '550,000円', '430,000円', '約1.6ヶ月'],
  ];
  const cell = (t, o = {}) => ({ text: t, options: Object.assign({ fontFace: F, fontSize: 14, color: T, align: 'center', valign: 'middle' }, o) });
  const data = [hdr.map((h) => cell(h, { bold: true, color: K, fill: { color: Y }, fontSize: 13 }))]
    .concat(rows.map((r, i) => r.map((v, j) => cell(v, {
      bold: j === 0 || j === 6, fill: { color: j === 6 ? YS : (i % 2 ? G : WH) }, fontSize: j === 6 ? 16 : 14,
    }))));
  s.addTable(data, { x: 0.6, y: 2.25, w: W - 1.2, colW: [1.7, 1.1, 1.85, 1.65, 2.05, 1.85, 1.933], rowH: 0.62, border: { type: 'solid', pt: 0.75, color: 'DDDDDD' } });
  txt(s, '※「月間の想定価値」には、売上改善効果に加えて損害回避（ロス・事故防止など）の想定価値を含みます。実際の利益とは異なり、効果や投資回収を保証するものではありません。',
    { x: 0.6, y: 6.2, w: W - 1.2, h: 0.6, fontSize: 11, color: S, lineSpacingMultiple: 1.35 });
}

// ---------- 16. Price ----------
{
  const s = base(WH);
  heading(s, 'PRICE', '料金');
  txt(s, '① 本体価格', { x: 0.6, y: 1.75, w: 4, h: 0.4, fontSize: 17, bold: true, color: K });
  const models = [['16GBモデル', '327,000', '〜7台'], ['32GBモデル', '382,000', '〜18台'], ['64GBモデル', '482,000', '〜40台'], ['96GBモデル', '726,000', '〜50台']];
  const cw = 1.95, gap = 0.18;
  models.forEach(([m, p, n], i) => {
    const x = 0.6 + i * (cw + gap), y = 2.3;
    card(s, x, y, cw, 2.1);
    txt(s, m, { x, y: y + 0.2, w: cw, h: 0.35, fontSize: 14, bold: true, align: 'center', color: K });
    txt(s, [{ text: p, options: { fontSize: 26, bold: true } }, { text: ' 円', options: { fontSize: 12 } }], { x, y: y + 0.65, w: cw, h: 0.55, align: 'center', valign: 'middle', color: K });
    txt(s, '（税抜）', { x, y: y + 1.2, w: cw, h: 0.25, fontSize: 10, align: 'center', color: S });
    txt(s, '推奨カメラ台数 ' + n, { x, y: y + 1.55, w: cw, h: 0.3, fontSize: 11.5, bold: true, align: 'center', color: K });
  });
  txt(s, '※推奨台数は1080p映像の場合の目安です。', { x: 0.6, y: 4.5, w: 6, h: 0.25, fontSize: 10, color: S });

  // monthly highlight
  const mx = 9.35, mw = W - 0.6 - mx;
  s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: mx, y: 1.75, w: mw, h: 3.0, rectRadius: 0.15, fill: { color: K }, line: { type: 'none' } });
  txt(s, '③ 月額利用料', { x: mx + 0.3, y: 1.95, w: mw - 0.6, h: 0.35, fontSize: 15, bold: true, color: WH });
  txt(s, 'カメラ1台あたり', { x: mx + 0.3, y: 2.45, w: mw - 0.6, h: 0.3, fontSize: 12, color: 'DDDDDD' });
  txt(s, [{ text: '15,000', options: { fontSize: 32, bold: true, color: Y } }, { text: ' 円／月', options: { fontSize: 13, color: WH } }], { x: mx + 0.3, y: 2.8, w: mw - 0.5, h: 0.75, valign: 'middle' });
  txt(s, '（税抜）5台 75,000円／10台 150,000円／15台 225,000円', { x: mx + 0.3, y: 3.65, w: mw - 0.6, h: 0.5, fontSize: 10.5, color: 'DDDDDD', lineSpacingMultiple: 1.3 });
  txt(s, 'ソフトウェア利用料とトラブル時の対応を含みます。', { x: mx + 0.3, y: 4.2, w: mw - 0.6, h: 0.4, fontSize: 10.5, color: 'DDDDDD' });

  // storage
  txt(s, '② ストレージ込みの参考価格', { x: 0.6, y: 4.95, w: 5, h: 0.4, fontSize: 17, bold: true, color: K });
  const st = [['カメラ1〜5台', '506,170円', 'SSD 4TB＋HDD 15TB'], ['カメラ5〜10台', '668,867円', 'SSD 4TB＋HDD 30TB'], ['カメラ10〜30台', '1,259,342円', 'SSD 4TB＋HDD 90TB'], ['カメラ30〜50台', '1,952,130円', 'SSD 4TB＋HDD 150TB']];
  st.forEach(([a, p, d], i) => {
    const x = 0.6 + i * (cw + gap), y = 5.45;
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y, w: cw, h: 1.3, rectRadius: 0.1, fill: { color: G }, line: { type: 'none' } });
    txt(s, a, { x, y: y + 0.12, w: cw, h: 0.3, fontSize: 12, bold: true, align: 'center', color: K });
    txt(s, p, { x, y: y + 0.45, w: cw, h: 0.4, fontSize: 18, bold: true, align: 'center', color: K });
    txt(s, d, { x, y: y + 0.9, w: cw, h: 0.28, fontSize: 10, align: 'center', color: S });
  });
  txt(s, '※税抜。15fps・12ヶ月保存を前提とした、2026年8月時点の資料に基づく試算です。', { x: 0.6, y: 6.85, w: 8.5, h: 0.25, fontSize: 10, color: S });

  // notes
  txt(s, '④ ご注意事項', { x: mx, y: 4.95, w: mw, h: 0.4, fontSize: 17, bold: true, color: K });
  const notes = ['台数に応じた値引きがあります。', '追加開発は別途お見積りです。', 'SSD・HDD・PoE機器・施工費は本体価格に含まれません。', 'カメラ50台以上は個別お見積りの対象です。'];
  txt(s, notes.map((n, i) => ({ text: n, options: { bullet: true, breakLine: i < notes.length - 1 } })), { x: mx, y: 5.45, w: mw, h: 1.5, fontSize: 11, color: T, paraSpaceAfter: 4 });
}

// ---------- 17. Flow ----------
{
  const s = base(G);
  heading(s, 'FLOW', '導入の流れ');
  const steps = [['ヒアリング', '現在のカメラ環境と課題をお伺いします。'], ['ご提案', '必要な機能・台数・構成とお見積りをご提示します。'], ['設計・実証', '必要に応じて設計と追加実証を行います。'], ['本番導入', '本体を設置し、本番運用を開始します。'], ['月次確認（6ヶ月）', '導入後6ヶ月間、月次で分析結果と運用を確認します。']];
  const cw = 2.25, gap = 0.2, x0 = (W - (cw * 5 + gap * 4)) / 2, y0 = 2.3;
  s.addShape(pres.shapes.RECTANGLE, { x: x0 + cw / 2, y: y0 + 0.55, w: (cw + gap) * 4, h: 0.06, fill: { color: K }, line: { type: 'none' } });
  steps.forEach(([t, d], i) => {
    const x = x0 + i * (cw + gap);
    hex(s, x + cw / 2 - 0.6, y0, 1.2, { line: { color: K, width: 2 } });
    txt(s, String(i + 1), { x: x + cw / 2 - 0.6, y: y0, w: 1.2, h: 1.04, fontSize: 28, bold: true, align: 'center', valign: 'middle', color: K });
    card(s, x, y0 + 1.4, cw, 2.5, { line: { type: 'none' } });
    txt(s, t, { x: x + 0.15, y: y0 + 1.6, w: cw - 0.3, h: 0.45, fontSize: 16, bold: true, align: 'center', color: K });
    txt(s, d, { x: x + 0.22, y: y0 + 2.2, w: cw - 0.44, h: 1.5, fontSize: 12.5, color: S, lineSpacingMultiple: 1.4 });
  });
  txt(s, '※ヒアリングからご提案まで約1週間〜10日。追加実証を行う場合は2〜4ヶ月が目安です。', { x: 0.6, y: 6.6, w: 11, h: 0.3, fontSize: 12, color: S });
}

// ---------- 18. FAQ ----------
{
  const s = base(WH);
  heading(s, 'FAQ', 'よくある質問');
  const qa = [
    ['今使っている防犯カメラはそのまま使えますか？', '多くの場合、既存の防犯カメラをそのまま利用できます。機種や接続方式によって対応可否が異なるため、事前のヒアリングで確認します。'],
    ['映像が外部に送られることはありますか？', '映像は施設内に設置した本体で処理します。外部への通知は映像を含まない匿名テキストで行います。'],
    ['インターネットが切れたらどうなりますか？', '本体はローカルで稼働を続け、解析も継続します。ただし、回線が切断されている間は外部への通知が届かないなどの制約があります。'],
    ['掲載されている機能はすべて今すぐ使えますか？', '一部に開発予定・提供予定の機能を含みます。提供時期や対応範囲はお問い合わせ時にご案内します。'],
    ['初期費用以外に別途かかる費用はありますか？', 'SSD・HDD・PoE機器・施工費は本体価格に含まれず、別途必要です。追加開発をご希望の場合も別途お見積りとなります。'],
    ['導入までどのくらいかかりますか？', 'ヒアリングからご提案まで約1週間〜10日が目安です。追加実証を行う場合は2〜4ヶ月程度を見込んでください。'],
  ];
  const cw = (W - 1.2 - 0.3) / 2, ch = 1.45;
  qa.forEach(([q, a], i) => {
    const c = i % 2, r = Math.floor(i / 2);
    const x = 0.6 + c * (cw + 0.3), y = 1.95 + r * (ch + 0.22);
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y, w: cw, h: ch, rectRadius: 0.1, fill: { color: G }, line: { type: 'none' } });
    s.addShape(pres.shapes.OVAL, { x: x + 0.2, y: y + 0.18, w: 0.42, h: 0.42, fill: { color: Y }, line: { type: 'none' } });
    txt(s, 'Q', { x: x + 0.2, y: y + 0.18, w: 0.42, h: 0.42, fontSize: 15, bold: true, align: 'center', valign: 'middle', color: K });
    txt(s, q, { x: x + 0.8, y: y + 0.16, w: cw - 1.0, h: 0.46, fontSize: 14.5, bold: true, valign: 'middle', color: K });
    txt(s, a, { x: x + 0.8, y: y + 0.66, w: cw - 1.0, h: 0.72, fontSize: 11.5, color: S, lineSpacingMultiple: 1.35 });
  });
}

// ---------- 19. Closing ----------
{
  const s = base(K, { noLogo: true, light: true });
  hexLine(s, 9.6, 0.6, 1.6); hex(s, 11.0, 1.4, 1.2); hexLine(s, 11.6, 4.8, 1.3); hex(s, 10.4, 5.6, 0.9); hexLine(s, 9.5, 6.3, 0.7);
  s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: 0.9, y: 0.9, w: 2.6, h: 0.9, rectRadius: 0.12, fill: { color: WH }, line: { type: 'none' } });
  s.addImage({ path: img('logo.png'), x: 1.1, y: 1.08, w: 2.2, h: 2.2 * 119 / 486 });
  txt(s, 'カメラはそのまま。\nまずは今の環境でできることを\n確認しませんか。', { x: 0.9, y: 2.3, w: 9, h: 2.0, fontSize: 34, bold: true, color: WH, lineSpacingMultiple: 1.25 });
  s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: 0.9, y: 4.65, w: 5.6, h: 0.85, rectRadius: 0.42, fill: { color: Y }, line: { type: 'none' } });
  txt(s, '導入のご相談・お見積りは無料です', { x: 0.9, y: 4.65, w: 5.6, h: 0.85, fontSize: 20, bold: true, align: 'center', valign: 'middle', color: K });
  txt(s, 'お問い合わせ', { x: 0.9, y: 5.85, w: 3, h: 0.3, fontSize: 12, color: 'BBBBBB' });
  txt(s, 'info@hornet-v.com　／　03-4400-2790', { x: 0.9, y: 6.15, w: 8, h: 0.45, fontSize: 20, bold: true, color: WH });
}

pres.writeFile({ fileName: path.join(__dirname, 'HACHINOS_presentation.pptx') }).then((f) => console.log('wrote', f));
