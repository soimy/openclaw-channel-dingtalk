import classifySentenceWithEmoji from  '../../src/classifyWithEmoji';

// 测试用例
const testCases = [
  "你真棒！",
  "作业又没写完，太差了！",
  "马上去写作业！",
  "今天天气很好。",
  "你能帮我拿一下书吗？",
  "请开门",
  "快走",
  "这代码写得太烂了",
  "他昨天去了上海",
  "干得漂亮！",
  "能不能借我一支笔",
  "不准说话",
  "你好啊"
];

console.log('句子分类 + 颜文字：\n');
testCases.forEach(sent => {
  const result = classifySentenceWithEmoji(sent);
  console.log(`"${sent}" → ${result.type} ${result.emoji}`);
});
