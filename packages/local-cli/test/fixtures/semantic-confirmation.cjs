const { createSemanticFixture } = require("./semantic-holdout.cjs");

// Frozen before evaluating v2. The original holdout became a regression set after finding weak lexical admission.
function semanticConfirmationFixture() {
  return createSemanticFixture([
    ["water", "花园使用收集的雨水滴灌，每天日落后开启二十分钟。"],
    ["library", "借阅图书可续借一次，逾期后须先归还再办理新的借阅。"],
    ["repair", "自行车刹车松动时停止骑行，交由维修人员检查刹车线。"],
    ["ceramics", "陶器烧制前自然晾干至少两天，防止窑内开裂。"],
    ["delivery", "包裹投递失败后保留七天，收件人可凭取件码到驿站领取。"],
    ["registration", "社区课程报名每周一开放，未成年人需由监护人签字同意。"],
    ["permission", "开放实验室允许参观，但未经指导员许可不得操作仪器。"],
    ["identifier", "维修单 WX-856：冷藏柜门封条老化，需要更换密封胶条。"],
    ["old", "钽镓：旧版场馆开放安排。"],
    ["current", "场馆从下月起每天九点开放，周二闭馆清洁。", { external: "old", parent: "old" }],
    ["deleted", "锶铌：已作废的快递登记。"],
    ["tombstone", undefined, { external: "deleted", parent: "deleted", deleted: true }],
    ["hidden", "硒铬：受限制的内部课程名单。", { hidden: true }],
  ], [
    ["water", "花园什么时候浇水，用什么水？", ["water"]],
    ["library", "图书过期了还能直接再借一本吗？", ["library"]],
    ["repair", "车子的制动不可靠了该怎么办？", ["repair"]],
    ["ceramics", "怎样避免泥坯进窑后裂开？", ["ceramics"]],
    ["delivery", "快递没送成功，自己去哪里拿？", ["delivery"]],
    ["registration", "When can I enroll in the community class?", ["registration"]],
    ["permission", "参观者可以直接使用实验设备吗？", ["permission"]],
    ["identifier", "WX-856", ["identifier"]],
    ["current", "场馆哪天不开放？", ["current"]],
    ["filtered", "花园浇水", [], { thread_ids: ["thread-library"] }],
    ["hidden", "硒铬", []],
    ["deleted", "锶铌", []],
    ["superseded", "钽镓", []],
    ["unrelated", "怎样计算木星卫星的公转周期？", []],
    ["noise", "zzqx712zz", []],
  ], "semantic-synthetic-confirmation-v1");
}

module.exports = { semanticConfirmationFixture };
