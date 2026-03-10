/** 句子分类类型 */
type SentenceType = '夸奖' | '责怪' | '命令' | '叙事' | '请求' | '未知';

/** 分类结果 */
interface ClassifyResult {
  type: SentenceType;
  emoji: string;
}

/** 关键词分类配置 */
interface KeywordCategories {
  praise: readonly string[];
  blame: readonly string[];
  command: readonly string[];
  request: readonly string[];
}

/** 颜文字库 */
type EmojiMap = Record<SentenceType, readonly string[]>;

function classifySentenceWithEmoji(sentence: unknown): ClassifyResult {
  if (!sentence || typeof sentence !== 'string') {
    return { type: '未知', emoji: '(•̀_•́)' };
  }

  const s = sentence.trim();
  //  Chobits 
  const catchphrase = '叽 ';

  // ====== 分类关键词 ======
  const keywords: KeywordCategories = {
    praise: ['真棒', '太好了', '厉害', '优秀', '聪明', '好样的', '赞', '牛', '完美', '出色', '真行', '干得漂亮', '天才', '棒极了'],
    blame: ['怎么又', '搞砸', '太差了', '烦死了', '讨厌', '笨', '蠢', '马虎', '不负责任', '乱来', '糟糕', '废物', '气死我了', '糟糕', '错了'],
    command: ['必须', '立刻', '马上', '赶紧', '不准', '不要', '别动', '别说', '别做', '快去', '去做', '给我', '听着', '站住', '闭嘴'],
    request: ['能不能', '可以吗', '好吗', '请', '麻烦', '帮个忙', '帮忙', '劳驾', '能否', '想请你', '能帮我', '借我', '方便吗']
  } as const;

  // 客套话排除（避免误判为命令）
  const politeExclusions: readonly string[] = ['别客气', '别介意', '别见怪', '别担心', '别着急'];

  const containsAny = (text: string, words: readonly string[]): boolean =>
    words.some(word => text.includes(word));

  const isPolitePhrase = politeExclusions.some(phrase => s.includes(phrase));
  const isQuestion = /吗|呢|？|\?/.test(s);
  const startsWithPlease = s.startsWith('请');
  const hasExclamation = /[!！]/.test(s);
  const imperativeStart = !isPolitePhrase && /^(快|别|不要|不准|必须|马上|立刻)/.test(s);

  let type: SentenceType;

  // 判断类型（优先级很重要）
  if (containsAny(s, keywords.request) || (isQuestion && (startsWithPlease || /帮|麻烦/.test(s)))) {
    type = '请求';
  } else if (imperativeStart || containsAny(s, keywords.command)) {
    type = '命令';
  } else if (containsAny(s, keywords.praise)) {
    type = '夸奖';
  } else if (containsAny(s, keywords.blame) || (hasExclamation && /烦|讨厌|笨|蠢|差|气死/.test(s))) {
    type = '责怪';
  } else {
    type = '叙事';
  }

  // ====== 颜文字库 ======
  const emojis: EmojiMap = {
    夸奖: [
      '(๑•̀ㅂ•́)و✧',
      '(ﾉ≧∀≦)ﾉ',
      '٩(๑>◡<๑)۶',
      '(★▽★)',
      '(⌒▽⌒)☆',
      '(*≧ω≦)',
      '(ง •_•)ง',
      'ヾ(≧▽≦*)o'
    ],
    责怪: [
      '(╬ Ò﹏Ó)',
      '(╯°□°）╯',
      '(▼皿▼#)',
      '(｡•́︿•̀｡)',
      '(╥﹏╥)',
      'ヽ(｀Д´)ﾉ',
      '(＃＞＜)',
      '(；′⌒`)'
    ],
    命令: [
      '(¬_¬)',
      '(｀ε´)',
      '(＃｀Д´)',
      '(●｀∀´●)',
      '┌（┌ *｀д´）┐',
      '(｀д´)',
      '(•̀へ •́ ╮ )',
      '(￣ω￣;)'
    ],
    叙事: [
      '(。・ω・。)',
      '(￣▽￣)',
      '(´• ω •`)',
      '(・・?)',
      '(。_。)',
      '(￣ω￣)',
      '(´▽`)',
      '(=_=)'
    ],
    请求: [
      '(っ´∀｀)っ',
      '(๑•̀ω•́๑)✧',
      '(づ｡◕‿‿◕｡)づ',
      '(p≧w≦q)',
      '(♡˙︶˙♡)',
      '(⁄ ⁄•⁄ω⁄•⁄ ⁄)',
      '(´;ω;｀)',
      '(人•ᴗ•✿)'
    ],
    未知: ['(•̀_•́)', '(；一_一)', '(???)']
  };

  // 随机选一个颜文字
  const emojiList = emojis[type];
  const randomEmoji = catchphrase + emojiList[Math.floor(Math.random() * emojiList.length)];

  return { type, emoji: randomEmoji };
}

export type { SentenceType, ClassifyResult };
export default classifySentenceWithEmoji;
