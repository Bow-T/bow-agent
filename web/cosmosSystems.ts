/**
 * 9 HỆ TRI THỨC — nguồn sự thật DUY NHẤT về danh tính các hệ của bow-agent (mã, màu, tính cách,
 * top-dir thuộc về hệ nào). Tách khỏi CosmosOverlay để cả hai màn trực quan hoá cùng đọc một
 * bảng: Cosmos (vũ trụ free-fly) và Bản đồ (quả cầu). KHÔNG khai lại danh sách này ở nơi khác.
 */
// ══════════════════════════════════════════════════════════════════════════════════════════════
// 9 HỆ = 9 HIỆN TƯỢNG KHÔNG GIAN. Mỗi hệ nhận-ra-được CHỈ QUA diện mạo (không dùng chung sphere).
//   pos: toạ độ (x,y,z) CỐ ĐỊNH bất đối xứng — RẢI ở nhiều tầng độ sâu, KHÔNG quanh gốc, KHÔNG đồng
//        phẳng. Vài hệ rất xa (LLM ~5200u, WEB ~6000u) → "barely visible in the distance".
//   kind: loại hiện tượng → quyết định hàm dựng hình + animation riêng.
//   radius: bán kính hiệu dụng (dùng cho LOD, cinematic-travel offset, hit-test).
//   dirs: các top-dir của repo thuộc về hệ này → file thật rơi vào đúng hệ (data→universe mapping).
// ══════════════════════════════════════════════════════════════════════════════════════════════
export type Kind = 'nebula' | 'energy' | 'wormhole' | 'star' | 'pulsar' | 'cluster' | 'belt' | 'beacon' | 'satellites';
export interface SystemDef {
  id: string;
  code: string;
  hue: number;
  kind: Kind;
  pos: [number, number, number];
  radius: number;
  dirs: string[];
  tagVi: string; tagEn: string;
  bodyVi: string; bodyEn: string;
}

export const SYSTEMS: SystemDef[] = [
  { id: 'memory', code: 'MEMORY', hue: 0.79, kind: 'nebula', pos: [-1900, 620, -2400], radius: 520,
    dirs: ['.claude', '.agents'],
    tagVi: 'Ghi nhớ · .claude/memory', tagEn: 'Notes · .claude/memory',
    bodyVi: 'Tinh vân tím trải rộng — <strong>ghi nhớ cách làm việc</strong> đúc kết qua nhiều phiên. Hàng nghìn hạt là hàng nghìn mảnh ký ức; bay vào trong sẽ thấy từng file memory phát sáng.',
    bodyEn: 'A vast purple nebula — <strong>how-we-work memory</strong> distilled across sessions. Thousands of motes are thousands of memory fragments; fly inside to see each memory file glow.' },
  { id: 'prompt', code: 'PROMPT', hue: 0.58, kind: 'energy', pos: [-650, 1050, 1500], radius: 300,
    dirs: [],
    tagVi: 'Người dùng · lệnh + media', tagEn: 'User · prompt + media',
    bodyVi: 'Trường năng lượng xanh cuộn chảy — <strong>câu lệnh của bạn</strong>. Nguồn châm ngòi mọi thứ: mỗi prompt phóng một luồng hạt về phía các hệ liên quan.',
    bodyEn: 'A flowing blue energy field — <strong>your prompt</strong>. The igniter of everything: each prompt hurls a particle stream toward the systems it touches.' },
  { id: 'brain', code: 'LLM', hue: 0.11, kind: 'star', pos: [3600, 900, -4200], radius: 640,
    dirs: [],
    tagVi: 'Não AI · model weights', tagEn: 'AI brain · model weights',
    bodyVi: 'Ngôi sao vàng khổng lồ ở rất xa — <strong>trọng số model</strong>, mọi thứ Claude đã học. Một mặt trời riêng của nó, không phải tâm của vũ trụ này. Giới hạn ở knowledge cutoff.',
    bodyEn: 'A giant golden star, very far away — <strong>model weights</strong>, everything Claude learned. A sun of its own, not the centre of this universe. Bounded by knowledge cutoff.' },
  { id: 'mcp', code: 'MCP', hue: 0.41, kind: 'wormhole', pos: [1700, -900, 2100], radius: 340,
    dirs: [],
    tagVi: 'Jira · Supabase · Codemagic', tagEn: 'Jira · Supabase · Codemagic',
    bodyVi: 'Wormhole xanh lục xoáy — <strong>dữ liệu sống ngoài repo</strong>: đọc Jira, truy vấn Supabase, kích build. Không-thời-gian bẻ cong khi một tool MCP mở.',
    bodyEn: 'A swirling green wormhole — <strong>live data outside the repo</strong>: read Jira, query Supabase, trigger builds. Spacetime bends open when an MCP tool fires.' },
  { id: 'database', code: 'DATABASE', hue: 0.54, kind: 'pulsar', pos: [-1500, -1300, 2600], radius: 260,
    dirs: [],
    tagVi: 'Supabase · Postgres', tagEn: 'Supabase · Postgres',
    bodyVi: 'Pulsar trắng quét chùm — <strong>cơ sở dữ liệu</strong>. Hiện diện khi MCP Supabase bật; chùm quét gấp khi có query.',
    bodyEn: 'A white pulsar sweeping its beam — <strong>the database</strong>. Present when the Supabase MCP is on; the beam quickens on query.' },
  { id: 'git', code: 'GIT', hue: 0.02, kind: 'cluster', pos: [-3200, -400, -600], radius: 460,
    dirs: [],
    tagVi: 'Lịch sử · commit · branch', tagEn: 'History · commits · branches',
    bodyVi: 'Cụm sao đỏ trầm — <strong>lịch sử phiên bản</strong>. Mỗi điểm là một dấu mốc; bùng sáng khi có commit thành công.',
    bodyEn: 'A deep-red star cluster — <strong>version history</strong>. Each point a milestone; it flares on a successful commit.' },
  { id: 'packages', code: 'PACKAGES', hue: 0.50, kind: 'belt', pos: [-2600, -700, 900], radius: 700,
    dirs: [],
    tagVi: 'node_modules · dependencies', tagEn: 'node_modules · dependencies',
    bodyVi: 'Vành đai thiên thạch cyan dày đặc — <strong>các dependency</strong> dự án dựa vào. Hàng nghìn khối lạnh trôi thành một vòng rộng.',
    bodyEn: 'A dense cyan asteroid belt — <strong>the dependencies</strong> the project stands on. Thousands of cold rocks drifting in a wide ring.' },
  { id: 'tools', code: 'TOOLS', hue: 0.46, kind: 'satellites', pos: [850, -350, -1100], radius: 240,
    dirs: [],
    tagVi: 'Skills · tool calls', tagEn: 'Skills · tool calls',
    bodyVi: 'Đội vệ tinh nhỏ quanh một tâm chung — <strong>skills & tool calls</strong>. Mỗi vệ tinh là một skill thật; sáng bừng theo tool đang chạy.',
    bodyEn: 'A fleet of small satellites around a shared hub — <strong>skills & tool calls</strong>. Each satellite a real skill; brightening with the running tool.' },
  { id: 'web', code: 'WEB', hue: 0.07, kind: 'beacon', pos: [4200, 1400, 4400], radius: 300,
    dirs: [],
    tagVi: 'WebSearch · WebFetch', tagEn: 'WebSearch · WebFetch',
    bodyVi: 'Đèn hiệu cam ở rìa xa nhất của vũ trụ — <strong>tra cứu ngoài</strong>: docs online khi thứ cần không có trong repo hay kiến thức nền. Xa nhất, mảnh nhất.',
    bodyEn: 'An orange beacon at the farthest rim — <strong>external lookup</strong>: online docs when the needed thing is not in the repo or base knowledge. Farthest, faintest.' },
];
