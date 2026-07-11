---
name: rn-realtime
description: Wire Supabase realtime trong app React Native đúng cách — subscribe trong một custom hook, giữ channel trong ref, LUÔN removeChannel khi unmount (không leak), áp CÙNG filter mà server query dùng, và re-sync UI khi row đổi live. Dùng khi thêm/sửa một realtime subscription (postgres_changes / broadcast / presence), một live badge/count, hay bất kỳ màn hình phải cập nhật khi DB đổi. Bản RN của [[flutter-realtime]]. Đi cặp với [[rn-convention]] và [[rn-supabase-data]].
---

# Bow RN Realtime — subscribe, filter, và LUÔN dọn dẹp

Mục tiêu: một tính năng realtime cập nhật live VÀ tear-down sạch — không leak
channel, không badge lệch khỏi server count. Đây là bản React Native của
[[flutter-realtime]]; cùng bug class, chỉ khác lifecycle (hook + `useEffect`
cleanup thay cho `BaseViewModel.dispose`).

Stack: `@supabase/supabase-js` `supabase.channel(...)`. Realtime logic thuộc về
một **custom hook** (không nằm rải trong component), channel **được giữ trong
`useRef`** và gỡ trong cleanup của `useEffect`.

## 1. Subscription chuẩn — hook sở hữu channel, dọn trong cleanup
```tsx
function useDeliveryTracking(bookingId: string) {
  const [row, setRow] = useState<Delivery | null>(null);
  const channelRef = useRef<RealtimeChannel | null>(null);

  useEffect(() => {
    const channel = supabase
      .channel(`delivery_tracking_${bookingId}`)      // tên unique, scoped
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'deliveries',
          filter: `booking_id=eq.${bookingId}`,       // CÙNG filter với query
        },
        (payload) => setRow(payload.new as Delivery),
      )
      .subscribe();

    channelRef.current = channel;

    return () => {
      supabase.removeChannel(channel);                // LUÔN dọn — tránh leak
      channelRef.current = null;
    };
  }, [bookingId]);                                     // re-subscribe khi id đổi

  return row;
}
```

## 2. Bốn bug class phải tránh (giống Flutter)
1. **Leak channel** — quên `removeChannel` trong cleanup → mỗi lần mount thêm 1
   subscription, memory phình, callback chạy trùng.
2. **Filter lệch** — filter của subscription khác filter của query đọc ban đầu →
   UI nhận event của row không thuộc màn hình này.
3. **Badge drift** — cập nhật count bằng cách +1/-1 từ event thay vì đọc lại
   nguồn thật → lệch dần khỏi server count.
4. **Stale closure** — dùng biến ngoài trong callback mà không đưa vào deps →
   callback đọc giá trị cũ.

## 3. Checklist trước khi coi là xong
- [ ] `removeChannel` nằm trong return của `useEffect`.
- [ ] `filter` của subscription khớp `.eq()` của query đọc.
- [ ] Deps của `useEffect` đủ (id, các biến callback đọc).
- [ ] Test unmount → subscription thật sự bị gỡ (không còn callback chạy).
