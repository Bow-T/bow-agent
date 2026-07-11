/**
 * Wrapper icon thống nhất cho toàn app — dùng bộ Iconsax (variant Bold).
 *
 * Vì sao có file này thay vì import trực tiếp từ 'iconsax-react' ở mỗi chỗ:
 * - Gom tên icon về một bảng `ICONS` → đổi 1 icon = sửa 1 dòng, mọi nơi cập nhật theo.
 * - Ép sẵn variant="Bold", size & color mặc định (currentColor) → gọi ngắn gọn,
 *   icon luôn ăn theo màu chữ của phần tử cha (hover/theme tự đổi màu miễn phí).
 *
 * Dùng: <Icon name="bug" />  hoặc  <Icon name="folder" size={18} />
 * Thêm icon mới: tìm tên component trên iconsax-react, thêm 1 dòng vào ICONS.
 */
import {
  TaskSquare,
  Lamp,
  Book1,
  Global,
  Wifi,
  Moon,
  Sun1,
  CloseSquare,
  TickCircle,
  CloseCircle,
  Setting2,
  Cpu,
  Magicpen,
  Lock1,
  ArrowRight2,
  ArrowDown2,
  ArrowUp2,
  Timer1,
  RecordCircle,
  Danger,
  InfoCircle,
  Warning2,
  SearchNormal1,
  Folder,
  DocumentText,
  Book,
  Gallery,
  Paperclip,
  Trash,
  AddSquare,
  Messages2,
  MessageText,
  ArchiveBook,
  Edit2,
  Stop,
  Send2,
  Routing2,
  Hierarchy,
  People,
  TickSquare,
  Stop as StopSquare,
  RecordCircle as RadioOn,
  Record as RadioOff,
  Copy,
  ClipboardTick,
  ShieldSearch,
  DocumentCode,
  Broom,
  type Icon as IconType,
} from 'iconsax-react';

/** Bảng ánh xạ tên ngữ nghĩa → component Iconsax. Chỉ sửa ở đây khi muốn đổi icon. */
const ICONS: Record<string, IconType> = {
  copy: Copy,
  // Quick prompts
  bug: TaskSquare,
  lamp: Lamp,
  book: Book1,
  test: ClipboardTick,
  review: ShieldSearch,
  commit: DocumentCode,
  refactor: Broom,
  // Header / toolbar
  lang: Global,
  mcp: Wifi,
  moon: Moon,
  sun: Sun1,
  close: CloseSquare,
  // Pipeline / trạng thái
  pending: Timer1,
  dot: RecordCircle,
  success: TickCircle,
  error: CloseCircle,
  tool: Setting2,
  block: Danger,
  agent: Cpu,
  magic: Magicpen,
  lock: Lock1,
  routing: Routing2,
  structure: Hierarchy,
  users: People,
  chat: MessageText,
  // Caret
  caretRight: ArrowRight2,
  caretDown: ArrowDown2,
  caretUp: ArrowUp2,
  // Approval / thông báo
  warning: Warning2,
  info: InfoCircle,
  pin: RecordCircle,
  // Detect / attach
  search: SearchNormal1,
  folder: Folder,
  doc: DocumentText,
  pdf: Book,
  image: Gallery,
  attach: Paperclip,
  trash: Trash,
  newChat: AddSquare,
  history: ArchiveBook,
  rename: Edit2,
  stopCircle: Stop,
  send: Send2,
  // Question card — ô chọn (checkbox / radio)
  checkOn: TickSquare,
  checkOff: StopSquare,
  radioOn: RadioOn,
  radioOff: RadioOff,
};

export type IconName = keyof typeof ICONS;

interface IconProps {
  name: IconName;
  /** Cỡ (px). Mặc định 18 — hợp với nút/chip; nút to có thể tăng. */
  size?: number;
  /** Màu. Mặc định currentColor → ăn theo màu chữ phần tử cha. */
  color?: string;
  className?: string;
  /** Iconsax hỗ trợ Bold/Outline/... — mặc định Bold theo yêu cầu thiết kế. */
  variant?: 'Bold' | 'Outline' | 'Linear' | 'TwoTone' | 'Bulk' | 'Broken';
}

/** Render một icon Iconsax theo tên trong ICONS. Icon lạ → không render gì (fail-safe). */
export function Icon({ name, size = 18, color = 'currentColor', className, variant = 'Bold' }: IconProps) {
  const Cmp = ICONS[name];
  if (!Cmp) return null;
  return <Cmp size={size} color={color} variant={variant} className={className} aria-hidden="true" />;
}
