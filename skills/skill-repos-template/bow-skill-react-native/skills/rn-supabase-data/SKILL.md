---
name: rn-supabase-data
description: Lớp data Supabase cho React Native — gọi query/mutation trong services, xử lý lỗi và loading nhất quán, tôn trọng RLS (không tin dữ liệu tiền/giảm giá từ client), và map row DB sang model. Dùng khi thêm/sửa một truy vấn hoặc mutation Supabase trong app RN. Bản RN của lớp data Flutter. Đi cặp với [[rn-realtime]] và [[rn-convention]].
---

# Bow RN Supabase Data — query/mutation an toàn, có model

Mục tiêu: mọi truy cập Supabase nằm gọn trong `services/`, có xử lý lỗi/loading
nhất quán, và không tin dữ liệu nhạy cảm từ client. Đây là bản React Native của
lớp data Flutter trong dự án Bow.

## 1. Query nằm trong service, trả model đã map
```ts
// services/deliveryService.ts
export const deliveryService = {
  async getByBooking(bookingId: string): Promise<Delivery> {
    const { data, error } = await supabase
      .from('deliveries')
      .select('*')
      .eq('booking_id', bookingId)     // filter này phải khớp filter realtime
      .single();

    if (error) throw new DataError('load-delivery', error);
    return mapDelivery(data);          // map row → model, không rò shape DB ra UI
  },
};
```

## 2. Không tin client cho dữ liệu nhạy cảm
- Số tiền, giảm giá, quyền sở hữu: **không** gửi từ client rồi ghi thẳng. Xác
  thực server-side (RLS `WITH CHECK`, RPC `SECURITY DEFINER`, hoặc Edge Function).
- Mutation `insert`/`update`: kiểm tra ownership của MỌI foreign key liên quan,
  không chỉ `auth.uid() = user_id`.

## 3. Lỗi & loading nhất quán
- Service `throw` lỗi có domain (`DataError`), hook bắt và phơi `{ data, error,
  loading }`. Component chỉ render 3 trạng thái đó, không tự try/catch.

## 4. Checklist
- [ ] Query/mutation nằm trong `services/`, không trong component.
- [ ] Dữ liệu tiền/giảm giá/ownership được xác thực server-side.
- [ ] Row DB được map sang model trước khi trả về UI.
- [ ] Filter query khớp filter của subscription realtime tương ứng.
