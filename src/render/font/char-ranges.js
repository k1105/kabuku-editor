/**
 * Character set presets for "Import from Font". Each preset returns an array
 * of single-character strings (no duplicates within a preset).
 *
 * Ranges:
 *   - latin:    printable ASCII U+0021..U+007E
 *   - hiragana: U+3041..U+3096 (basic) + iteration / voiced marks U+309D..U+309F
 *   - katakana: U+30A1..U+30FA + iteration marks U+30FD..U+30FF
 *   - joyo:     2,136 Jōyō kanji (2010 cabinet revision)
 */

function range(from, to) {
  const out = [];
  for (let cp = from; cp <= to; cp++) out.push(String.fromCodePoint(cp));
  return out;
}

export function asciiPrintable() {
  return range(0x21, 0x7E);
}

export function hiragana() {
  return [...range(0x3041, 0x3096), ...range(0x309D, 0x309F)];
}

export function katakana() {
  return [...range(0x30A1, 0x30FA), ...range(0x30FD, 0x30FF)];
}

// Jōyō kanji (2,136 chars, 2010 revision). Source: davidluzgouveia/kanji-data
// (kanji-jouyou.json). Ordered by grade then frequency.
const JOYO =
  '一二九七人入八力十三上下口大女山川工刀土千夕子小丁了又丸才中五六円天手文日月木水火犬王出右四左本正玉田白目石立万久今元公' +
  '内分切午友太少引心戸方牛父毛止兄冬北半古台外市広母用矢世主他代写去号央平打氷申皮皿礼休先名字年早気百竹糸耳虫村男町花見貝' +
  '赤足車不仕交会光同回多当毎池米羽考肉自色行西何体作図声売弟形来社角言谷走近里麦学林空金雨青草音化地両全向安州曲有次死羊血' +
  '京国夜妹姉店明東歩画直知長前南室後思星活海点科茶食首欠氏由札民辺付以失必未末校夏家弱時紙記通高強教理組船週雪魚鳥黄黒支住' +
  '助医君対局役投決究身者研馬森場朝番答絵買道間雲数楽話電所事使具受和始定実服泳物苦表部乗客屋度待持界発相県美負送重談要勝仮' +
  '起速配酒院終習転進落葉軽運開集飲業漢路農鉄歌算聞語読鳴線横調親頭顔病最争仲伝共好成老位低初別利努労命岸放昔波注育拾指洋神' +
  '秒級追戦競良功特便働令意味勉庭息旅根流消倍員島祭章第都動商悪族深球童陽階寒悲暑期植歯温港湯登着短野泉生亡合風予反新返問宿' +
  '想感整暗様橋福緑練詩銀題館駅億器士料標殺然熱課賞輪選鏡願養像情謝映疑皆例卒協参周囲固季完希念折望材束松残求的約芸基性技格' +
  '能術私骨妥雰頑寺岩帰春昼晴秋計列区坂式信勇単司変夫建昨毒法泣浅紀英軍飯仏築晩猫園曜書遠門係取品守幸急真箱荷面典喜府治浴笑' +
  '辞関保弁政留証険危存専冒冗阪原細薬鼻側兵堂塩席敗果栄梅無結因常識非干是渉虚官察底愛署警恋覚説幻訓試弓告種達類報祈等汽借焼' +
  '座忘洗胸脳僧禅験可許枚静句禁喫煙加節減順容布易財若詞昆閥歴舌冊宇宙忙履団暴混乱徒得改続連善困絡比災機率飛害余難妨被裕震尻' +
  '尾械確嫌個圧在夢産倒臭厚妻議犯罪防穴論経笛史敵済委挙判制務査総設資権件派岡素断評批任検審条責省増税解際認企義罰誕脱過坊寝' +
  '宮各案置費価勢営示統領策藤副観値吸域姿応提援状態賀収停革職鬼規護割裁崎演律師看準則備導幹張優宅沢施現乳呼城俳秀担額製違輸' +
  '燃祝届狭肩腕腰触載層型庁視差管象量境環武質述供展販株限与含影況渡響票景抜訴訟逮補候構模捕鮮効属慣豊満肥巻捜絞輩隠掛替居造' +
  '授印創復往較筆鉛貯故障従我激刺励討郵針徴怪獣突菓河振汗豚再接独占招段胃腹痛退屈悩暇織貸迷惑誘就訪怒昇眠睡症締迫靴濃端極途' +
  '健康郎給逆巨庫児冷凍幼稚処博清潔録隊修券婦奇妙麗微益移程精絶並憲衆傘浜撃攻監杯乾催促欧江請雄韓壊診閣僚積督臣略航寄板街宗' +
  '緊娘宴怖恐添猛烈索詰詳魅渇系婚遊旗照快版貧乏適預延翌覧懐押更枕浮漏符購越飾騒背撮盗離融編華既普豪鑑除尋幾廊掃泥棒驚嘆倉孫' +
  '巣帯径救散粉脈菜貨陸似均墓富徳探偵序迎志恩採桜永液眼祖績興衛複雑賛酸銭飼傷党卵厳捨込密汚欲暖机秘訳染簡閉誌窓否筋垂宝宣尊' +
  '忠拡操敬暮灰熟異皇盛砂漠糖納肺著蒸蔵装裏諸賃誤臓貴降丼吐奴隷芋縮純縦粋聖磁紅射幕拝薦推揮沿源劇勤歓承損枝爪豆刻腐遅彫測破' +
  '舎講滞紹介己厄亀互剣寿彼恥杉汁炎為熊獄酔酢鍋湖銅払油旧姓貿将盟遺伸債及奈幅廃甘換摘核沖縄津献療継維舞伎踏般頼依鹿諾牙跳昭' +
  '漁償刑募執塁崩患戻抗抵旬湾爆弾聴跡遣闘陣香兆臨削契恵抱掲狙葬需齢宜繰避妊娠致刊奏伴併傾却奥慮懸房扱抑択描盤称緒緩託賄賂贈' +
  '逃還超邦鈴阜岐隆雇控壁棋渋片群仙充免勧圏埋埼奪御慎拒枠甲祉稲譲謙躍銃項鋼顧駐駆柱唱孝俊兼剤吹堀巡戒排携敏鋭敷殿犠獲茂繁頻' +
  '殖薄衝誉褒透隣雅遜伺徹瀬撤措拠儀樹棄虎蛍蜂酎蜜艦潜拳炭畑包衣仁鉱至誠郷侵偽克到双哲喪堅床括弧挑掘揚握揺斎暫析枢軸柄泊滑潟' +
  '焦範紛糾綱網肝芝荒袋誰珍裂襲貢趣距籍露牧刷朗潮即垣威封筒岳慰懇懲摩擦撲斉旨柔沈沼泰滅滋炉琴寸竜縁翼吉刃忍桃辛謎侍俺叱娯斗' +
  '朱丘梨僕匹叫釣髪嵐涙缶姫棚粒砲雷芽塔澄矛肌舟鐘凶塊狩頃魂脚井呪嬢暦曇眺裸賭疲塾卓磨菌陰霊湿硬稼嫁溝滝狂墨穏鈍魔寮盆棟斬寧' +
  '椅歳涼猿瞳鍵零碁租幽泡癖鍛錬穂帝瞬菊誇阻黙俵綿架砕粘粧欺詐霧柳佐尺哀唇塀墜如婆崖帽幣恨憎憩扇扉挿掌滴炊爽畳瞭箸胴芯虹帳蚊' +
  '蛇貼辱鉢闇隙霜飢餓畜迅騎蓄尽彩憶溶耐踊賢輝脅麻灯咲培悔脇遂班塗斜殴盾穫巾駒紫抽誓悟拓拘礎鶴刈剛唯壇尼概浸淡煮覆謀陶隔征陛' +
  '俗桑潤珠衰奨劣勘妃丈峰巧邪駄唐廷鬱簿彰漫訂諮銘堤漂翻軌后奮亭仰伯偶墳壮把搬晶洞涯疫孔偉頂召挟枯沸濯燥瓶耕肯脂膚軒軟郊隅隻' +
  '邸郡釈肪喚媛貞玄苗渦慈襟浦塚陥貫覇呂茨擁孤賠鎖噴祥牲秩唆膨芳恒倫陳須偏遇糧殊慢没怠遭惰猟寛胞浄随稿丹壌舗騰緯艇披錦准剰繊' +
  '諭惨虐据徐搭戴帥啓鯨荘栽拐冠勲酬紋卸欄逸尚顕粛愚庶践呈疎疾謡鎌酷叙且痴哺傲茎悠伏鎮奉憂朴栃惜佳悼該赴髄傍累癒郭尿賓虜憾弥' +
  '粗循凝脊旦愉抹栓那拍猶宰寂縫呉凡恭錯穀陵弊舶窮悦縛轄弦窒洪摂飽紳庸搾碑尉匠賊鼓旋腸槽伐漬坪紺羅峡俸醸弔乙遍衡款閲喝敢膜盲' +
  '胎酵堕遮凸凹瑠硫赦窃慨扶戯忌濁奔肖朽殻享藩媒鶏嘱迭椎絹陪剖譜淑帆憤酌暁傑錠璃遷拙峠篤叔雌堪吟甚崇漆岬紡礁屯姻擬睦閑曹詠卑' +
  '侮鋳蔑胆浪禍酪憧慶亜汰沙逝匿寡痢坑藍畔唄拷渓廉謹湧醜升殉煩劾桟婿慕罷矯某囚泌漸藻妄蛮倹挨宛畏萎壱咽淫韻臼餌謁怨艶旺翁臆箇' +
  '苛蓋骸柿嚇顎葛褐釜瓦棺玩畿僅斤虞串窟薫稽詣桁舷股乞侯勾喉慌梗墾痕挫塞采柵拶蚕嗣肢賜璽嫉爵腫儒愁蹴遵宵抄硝詔拭薪腎裾畝凄醒' +
  '戚斥煎羨腺詮繕膳塑曽遡痩捉袖唾堆但綻逐嫡衷勅捗朕潰諦逓溺妬痘謄頓弐匂捻罵剥斑氾汎頒眉膝肘賦附丙蔽倣貌勃昧繭冥麺耗餅冶妖窯' +
  '沃濫吏侶厘弄楼麓刹喩嗅嘲毀彙恣惧慄憬拉摯曖楷璧瘍箋籠緻羞訃諧貪踪辣錮塡頰';

export function joyoKanji() {
  return Array.from(JOYO);
}

export const PRESETS = [
  { id: 'latin',    label: 'Latin (ASCII)',  build: asciiPrintable },
  { id: 'hiragana', label: 'Hiragana',       build: hiragana },
  { id: 'katakana', label: 'Katakana',       build: katakana },
  { id: 'joyo',     label: 'Jōyō Kanji',     build: joyoKanji },
];

/**
 * Combine selected presets + custom text into a deduplicated, ordered list.
 * @param {string[]} presetIds  preset IDs (subset of PRESETS[*].id)
 * @param {string}   customText extra characters (any duplicates removed)
 */
export function buildCharSet(presetIds, customText = '') {
  const seen = new Set();
  const out = [];
  function add(ch) {
    if (!ch || seen.has(ch)) return;
    seen.add(ch);
    out.push(ch);
  }
  for (const id of presetIds) {
    const preset = PRESETS.find(p => p.id === id);
    if (!preset) continue;
    for (const ch of preset.build()) add(ch);
  }
  for (const ch of Array.from(customText)) add(ch);
  return out;
}
