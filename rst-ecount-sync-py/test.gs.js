function triggerPermission() {
  // บรรทัดนี้จะบังคับให้ระบบ Google ตรวจสอบสิทธิ์ยิง API ใหม่ทั้งหมด
  var res = UrlFetchApp.fetch("https://oapi.ecount.com");
  Logger.log(res.getResponseCode());
}