"use strict";

// Pronunciation tips for Japanese speakers, keyed by the IPA symbols Azure returns.
const TIPS = {
  "ɹ": { name: "R", tip: "舌先をどこにも付けずに奥へ引き、唇を少し丸めて突き出す。最初に小さく『ゥ』を入れる感じ(right → ゥライト)。日本語のラ行のように舌で弾かない。" },
  "r": { name: "R", tip: "舌先をどこにも付けずに奥へ引き、唇を少し丸めて突き出す。日本語のラ行のように舌で弾かない。" },
  "l": { name: "L", tip: "舌先を上の前歯の裏の歯ぐきにしっかり押し付けたまま声を出す。語末の L(call, deal, quickly の l)も舌を付けて、こもった『ゥ』のように。" },
  "θ": { name: "TH(無声)", tip: "舌先を上下の歯で軽くはさみ、そのすき間から息だけを出す(think, three)。『ス』や『ト』にしない。" },
  "ð": { name: "TH(有声)", tip: "θ と同じく舌先を歯ではさんだまま声を出す(the, they, that)。『ザ』『ダ』にしない。弱い単語でも舌は歯に当てる。" },
  "v": { name: "V", tip: "上の前歯を下唇の内側に軽く当て、震わせながら声を出す(very, involve)。両唇で『バ』と言わない。" },
  "f": { name: "F", tip: "上の前歯を下唇に軽く当てて息を出す(fee, fixed)。日本語の『フ』のように唇だけで出さない。" },
  "b": { name: "B", tip: "両唇をしっかり閉じてから破裂させる。V と区別する。" },
  "w": { name: "W", tip: "唇を強くすぼめた『ウ』の形から一気に開く(work, would, with)。woman / would の頭を省略しない。" },
  "j": { name: "Y", tip: "舌の中央を上あごに近づけて『ィ』から始める(year, you)。year と ear を区別。" },
  "h": { name: "H", tip: "のどから息だけを出す(have, who)。『フ』の唇にしない。" },
  "s": { name: "S", tip: "舌先を歯ぐきに近づけて強い息。si を『シ』にしない(city, system)。" },
  "z": { name: "Z", tip: "S の口のまま声を出す。語末の -s が濁る語(things, agreements, teams)は最後まで『ズ』を響かせる。『ズ』の後に母音を付けない。" },
  "ʃ": { name: "SH", tip: "唇を丸めて突き出し、舌を少し奥に引いて『シュ』(she, compliance の ti)。" },
  "ʒ": { name: "ZH", tip: "SH の口のまま声を出す(usually, decision)。『ジ』のように舌を付けない。" },
  "tʃ": { name: "CH", tip: "舌先を歯ぐきに付けてから『チュ』と離す。唇は少し丸める(checklist, each)。" },
  "dʒ": { name: "J", tip: "舌先を歯ぐきに付けてから『ヂュ』と離す(manager, Japanese, job)。" },
  "t": { name: "T", tip: "舌先を歯ぐきに付けて強く破裂。語末の t に『オ』を付けない(contract → ×コントラクト)。アメリカ英語では母音にはさまれると軽い『ラ』に近くなる(better, data)。" },
  "d": { name: "D", tip: "語末の d に『オ』を付けない(confirmed, followed)。舌を歯ぐきに付けて止めるだけで十分。" },
  "k": { name: "K", tip: "語末の k に『ウ』を付けない(work, quick)。息を強めに。" },
  "g": { name: "G", tip: "語末の g に『ウ』を付けない。" },
  "p": { name: "P", tip: "語頭は強い息を伴って破裂させる(partner, process)。語末に『ウ』を付けない(setup)。" },
  "m": { name: "M", tip: "唇をしっかり閉じる。語末の m(system, team)も最後まで閉じる。" },
  "n": { name: "N", tip: "舌先を歯ぐきに付けて鼻から。語末の n(within, done)は舌を付けたまま終える(日本語の『ン』で口を開けない)。" },
  "ŋ": { name: "NG", tip: "舌の奥を上あごの奥に付けた鼻音(-ing, thing)。最後に強い『グ』を付けない。" },
  "æ": { name: "短い a(cat の a)", tip: "『エ』の口で『ア』と言う。口を横に開いてあごをしっかり下げる(manage, accurate, data)。" },
  "ʌ": { name: "短い u(cup の u)", tip: "口を軽く開けた、短く強い『ア』(customer, up, done)。" },
  "ɑ": { name: "長い o(hot の o)", tip: "口を縦に大きく開けた、のどの奥の『アー』(job, contract の o)。『オ』にしない。" },
  "ɔ": { name: "aw", tip: "唇を少し丸めた、口の奥の『オー』(call, thought)。" },
  "ə": { name: "あいまい母音", tip: "力を抜いた弱く短い『ア』。はっきり発音しすぎず、強く読む音節との差をつける(about, banana の最初の a)。" },
  "ɝ": { name: "ER(強い)", tip: "舌を奥に引いて口の中に浮かせたまま『アー』(work, first, service)。『ワーク』のように舌を休ませない。" },
  "ɚ": { name: "ER(弱い)", tip: "語末の -er/-or は、舌を奥に引いた弱い『ァ』(customer, manager)。『カスタマー』と伸ばさない。" },
  "ɪ": { name: "短い i(sit の i)", tip: "『イ』と『エ』の中間の短い音。口の力を抜く(billing, it, with)。" },
  "i": { name: "長い ee", tip: "口を横に引いて、はっきり長めの『イー』(team, each, agree)。" },
  "ɛ": { name: "短い e(bed の e)", tip: "日本語の『エ』より少し口を開く(set, every, invested)。" },
  "ʊ": { name: "短い oo(book の oo)", tip: "唇を軽く丸めた短い『ウ』(good, look, would)。" },
  "u": { name: "長い oo", tip: "唇を丸めて突き出す長い『ウー』(do, new, through)。" },
  "eɪ": { name: "ay", tip: "『エー』と伸ばさず『エイ』と最後まで動かす(day, rate, agreement)。" },
  "oʊ": { name: "oh", tip: "『オー』と伸ばさず『オウ』と唇を丸めて終える(go, know, process をアメリカ英語で)。" },
  "aɪ": { name: "eye", tip: "『アイ』をなめらかに一音で(time, I'm, quickly)。" },
  "aʊ": { name: "ow", tip: "『アウ』と唇を丸めて終える(about, out, account)。" },
  "ɔɪ": { name: "oy", tip: "『オイ』(choice, enjoy)。" },
};

function tipFor(ipa) {
  const key = String(ipa).replace(/[ˈˌː]/g, "");
  return TIPS[key] || TIPS[key[0]] || { name: "", tip: "お手本を聞いて、口の形と舌の位置をまねてみましょう。単語だけをゆっくり繰り返すのも効果的です。" };
}
