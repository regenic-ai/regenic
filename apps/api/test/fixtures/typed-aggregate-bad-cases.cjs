module.exports = [
  {
    name: "all-person task completion status",
    query: "统计下所有人近一个月的研发任务完成情况",
    spec: {
      version: 1,
      operation: "status_summary",
      metric: { id: "task_status", label: "Task status" },
      group_dimensions: [{ id: "person", label: "Person" }],
      subject: { terms: ["研发任务"], constraints: [] },
      value_type: "category",
      allowed_categories: [
        { id: "done", label: "Done" },
        { id: "in_progress", label: "In progress" },
      ],
      dedupe_strategy: "event_id",
    },
    facts: [
      { dedupe_key: "event_id:any", group: "Alice", metric: "task_status", value: "done", evidence_refs: [1] },
      { dedupe_key: "event_id:any", group: "Bob", metric: "task_status", value: "in_progress", evidence_refs: [2] },
    ],
    refs: ["task-1", "task-2"],
    expected: /category="done" total=1 \[1\].*category="in_progress" total=1 \[2\]/s,
  },
  {
    name: "Hollyland monthly video count",
    query: "Hollyland 最近一个月发布了多少条视频",
    spec: {
      version: 1,
      operation: "count",
      metric: { id: "published_video", label: "Published video" },
      group_dimensions: [{ id: "month", label: "Month" }],
      subject: {
        terms: ["hollyland", "video"],
        constraints: [{ field: "brand", operator: "equals", value: "hollyland" }],
      },
      value_type: "count",
      dedupe_strategy: "event_id",
    },
    facts: [
      { dedupe_key: "event_id:any", group: "2026-10", metric: "published_video", value: 1, evidence_refs: [1] },
      { dedupe_key: "event_id:any", group: "2026-10", metric: "published_video", value: 1, evidence_refs: [2] },
    ],
    refs: ["video-1", "video-2"],
    expected: /metric="published_video" total=2 \[1\] \[2\]/,
  },
  {
    name: "customers without replies",
    query: "列出近一个月没有回复的客户",
    spec: {
      version: 1,
      operation: "list",
      metric: { id: "customer", label: "Customer" },
      group_dimensions: [],
      subject: {
        terms: ["customer", "reply"],
        constraints: [{ field: "reply_status", operator: "equals", value: "missing" }],
      },
      value_type: "category",
      dedupe_strategy: "business_id",
    },
    facts: [
      { dedupe_key: "business_id:c-1", group: "without_reply", metric: "customer", value: "Acme", evidence_refs: [1] },
    ],
    refs: ["customer-event-1"],
    metadata: [{ event_id: "customer-event-1", business_id: "c-1" }],
    expected: /item="Acme" \[1\]/,
  },
  {
    name: "monthly project totals",
    query: "按月统计项目总数",
    spec: {
      version: 1,
      operation: "count",
      metric: { id: "project", label: "Project" },
      group_dimensions: [{ id: "month", label: "Month" }],
      subject: { terms: ["project"], constraints: [] },
      value_type: "count",
      dedupe_strategy: "external_id",
    },
    facts: [
      { dedupe_key: "external_id:p-1", group: "2026-09", metric: "project", value: 1, evidence_refs: [1] },
      { dedupe_key: "external_id:p-2", group: "2026-10", metric: "project", value: 1, evidence_refs: [2] },
    ],
    refs: ["project-event-1", "project-event-2"],
    metadata: [
      { event_id: "project-event-1", external_id: "p-1" },
      { event_id: "project-event-2", external_id: "p-2" },
    ],
    expected: /group="2026-09".*group="2026-10"/s,
  },
];
