import { GoogleGenAI, Type } from '@google/genai';

function getAIClient() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY chưa được thiết lập trong Settings > Secrets');
  }

  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

export async function parseRoomCostWithAI(userText, currentMonth, currentYear) {
  const ai = getAIClient();

  const prompt = `Trích xuất thông tin chi phí phòng trọ từ lời nói/văn bản sau đây của người dùng:
"${userText}"

Quy tắc xử lý chi tiết:
- Tháng (month): Nếu người dùng nói về tháng cụ thể (ví dụ "tháng 11", "tháng 12/2026"), trích xuất month theo định dạng YYYY-MM (dùng năm ${currentYear || 2026} nếu không nêu rõ năm). Nếu không nói tháng thì dùng tháng hiện tại: "${currentMonth || '2026-11'}".
- Tiền phòng/tiền trọ (rent): Số nguyên VND. Ví dụ: "2 triệu rưỡi" -> 2500000, "3tr" -> 3000000, "2tr8" -> 2800000, "3.2 triệu" -> 3200000. Nếu không nói thì để null.
- Tiền điện:
  - Nếu nói số công tơ (ví dụ "điện từ 120 đến 180 giá 3.5k" hoặc "số cũ 150 số mới 210 đơn giá 4000"):
    - elecMeter: { on: true, old: 150, new: 210, price: 4000 }
    - electric: (210 - 150) * 4000 = 240000
  - Nếu chỉ nói tổng tiền (ví dụ "điện 300k" hoặc "tiền điện 450 nghìn"):
    - electric: 300000
    - elecMeter: null
- Tiền nước:
  - Tương tự như điện, nếu nói theo số khối m3 cũ/mới và đơn giá:
    - waterMeter: { on: true, old: ..., new: ..., price: ... }
    - water: (new - old) * price
  - Nếu nói tổng tiền nước (ví dụ "nước 60k"):
    - water: 60000
    - waterMeter: null
- Các khoản khác (others):
  - Mảng các khoản phát sinh: Wifi, Tiền rác, Gửi xe, Dịch vụ, Thang máy, Gas, v.v.
  - Ví dụ: "wifi 100k, rác 30k, gửi xe 120k" -> [{ name: "Wifi", amount: 100000 }, { name: "Tiền rác", amount: 30000 }, { name: "Gửi xe", amount: 120000 }]
- Số người ở (people): Nếu có nói (ví dụ "phòng 2 người", "chia 3 người") -> số nguyên từ 1 đến 20. Nếu không nói thì để null.
- Trạng thái thanh toán (paid): true nếu có từ "đã đóng", "đã chuyển khoản", "đã trả", false nếu "chưa đóng" hoặc không nhắc.
- Ngày đóng (paidDate): YYYY-MM-DD nếu có nói rõ ngày đóng (hoặc hôm nay/hôm qua dựa trên năm ${currentYear || 2026}).
- Ghi chú (note): Bất kỳ lưu ý nào người dùng nói (ví dụ: "chủ nhà tăng giá điện từ tháng này").
- Tóm tắt (summary): Câu tóm tắt tiếng Việt ngắn gọn, dễ hiểu về các khoản đã nhận diện được.`;

  const response = await ai.models.generateContent({
    model: 'gemini-3.8-flash',
    contents: prompt,
    config: {
      systemInstruction: 'Bạn là chuyên gia trích xuất dữ liệu chi phí phòng trọ thông minh từ văn bản tiếng Việt tự nhiên và lời nói hàng ngày.',
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          month: { type: Type.STRING, description: 'Định dạng YYYY-MM' },
          rent: { type: Type.NUMBER, description: 'Tiền trọ VND' },
          electric: { type: Type.NUMBER, description: 'Tiền điện VND' },
          elecMeter: {
            type: Type.OBJECT,
            description: 'Công tơ điện',
            properties: {
              on: { type: Type.BOOLEAN },
              old: { type: Type.NUMBER },
              new: { type: Type.NUMBER },
              price: { type: Type.NUMBER },
            },
          },
          water: { type: Type.NUMBER, description: 'Tiền nước VND' },
          waterMeter: {
            type: Type.OBJECT,
            description: 'Đồng hồ nước',
            properties: {
              on: { type: Type.BOOLEAN },
              old: { type: Type.NUMBER },
              new: { type: Type.NUMBER },
              price: { type: Type.NUMBER },
            },
          },
          others: {
            type: Type.ARRAY,
            description: 'Các khoản phát sinh',
            items: {
              type: Type.OBJECT,
              properties: {
                name: { type: Type.STRING },
                amount: { type: Type.NUMBER },
              },
              required: ['name', 'amount'],
            },
          },
          people: { type: Type.NUMBER },
          paid: { type: Type.BOOLEAN },
          paidDate: { type: Type.STRING },
          note: { type: Type.STRING },
          summary: { type: Type.STRING, description: 'Tóm tắt các khoản đã trích xuất' },
        },
      },
    },
  });

  const rawJson = (response.text || '{}').trim();
  return JSON.parse(rawJson);
}
