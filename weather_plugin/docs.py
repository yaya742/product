"""A small Chinese API console for the campus weather plugin."""

from fastapi.responses import HTMLResponse


CHINESE_DOCS_HTML = r"""<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>校园天气插件</title>
  <style>
    :root { color-scheme: light; font-family: -apple-system, BlinkMacSystemFont, "Microsoft YaHei", sans-serif; }
    body { margin: 0; background: #f4f7fb; color: #172033; }
    main { max-width: 1040px; margin: 0 auto; padding: 32px 20px 56px; }
    h1 { margin: 0 0 8px; font-size: 30px; }
    h2 { margin: 0 0 16px; font-size: 20px; }
    p { color: #5c667a; }
    .intro { margin-bottom: 24px; }
    .intro a { color: #2563eb; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 16px; }
    .card { background: #fff; border: 1px solid #e5eaf2; border-radius: 14px; padding: 20px; box-shadow: 0 5px 18px rgba(30, 55, 90, .05); }
    .fields { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    label { display: flex; flex-direction: column; gap: 6px; color: #4d5870; font-size: 13px; }
    input, select, button { box-sizing: border-box; width: 100%; border: 1px solid #cfd7e6; border-radius: 8px; padding: 10px; font: inherit; }
    input:focus, select:focus { outline: 2px solid #bfdbfe; border-color: #2563eb; }
    button { margin-top: 14px; background: #2563eb; color: #fff; border: 0; cursor: pointer; font-weight: 600; }
    button:hover { background: #1d4ed8; }
    .result { grid-column: 1 / -1; min-height: 80px; white-space: normal; }
    .result.empty { color: #7a8497; }
    .metric-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(125px, 1fr)); gap: 10px; margin-top: 12px; }
    .metric { background: #f5f8ff; border-radius: 9px; padding: 12px; }
    .metric small { display: block; color: #66728a; margin-bottom: 5px; }
    .metric strong { font-size: 18px; }
    .good { color: #16803c; }
    .caution { color: #a16207; }
    .bad { color: #c2410c; }
    .notice { margin-top: 12px; padding: 10px 12px; background: #fff7ed; border-radius: 8px; color: #9a3412; }
    table { width: 100%; border-collapse: collapse; margin-top: 12px; font-size: 13px; }
    th, td { text-align: left; padding: 8px; border-bottom: 1px solid #edf0f5; }
    pre { overflow: auto; background: #101827; color: #d7e2f4; padding: 14px; border-radius: 9px; }
    @media (max-width: 540px) { .fields { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
<main>
  <section class="intro">
    <h1>校园天气插件</h1>
    <p>面向中国大学生的天气查询、预报和户外活动评估工具。</p>
    <p><a href="/swagger" target="_blank">打开原始 Swagger 接口文档</a> · <a href="/openapi.json" target="_blank">查看 OpenAPI 定义</a></p>
  </section>
  <section class="grid">
    <article class="card">
      <h2>查询当前天气</h2>
      <form id="current-form">
        <div class="fields">
          <label>纬度<input name="latitude" type="number" step="any" value="30.27" required></label>
          <label>经度<input name="longitude" type="number" step="any" value="120.15" required></label>
          <label>定位精度（米，可选）<input name="accuracy_m" type="number" min="0.1" step="any" placeholder="例如 35"></label>
        </div>
        <button type="submit">查询当前天气</button>
      </form>
    </article>

    <article class="card">
      <h2>查询未来预报</h2>
      <form id="forecast-form">
        <div class="fields">
          <label>纬度<input name="latitude" type="number" step="any" value="30.27" required></label>
          <label>经度<input name="longitude" type="number" step="any" value="120.15" required></label>
          <label>预报小时数<input name="hours" type="number" min="1" max="240" value="24" required></label>
        </div>
        <button type="submit">查询逐小时预报</button>
      </form>
    </article>

    <article class="card">
      <h2>评估户外活动</h2>
      <form id="activity-form">
        <div class="fields">
          <label>纬度<input name="latitude" type="number" step="any" value="30.27" required></label>
          <label>经度<input name="longitude" type="number" step="any" value="120.15" required></label>
          <label>活动类型<select name="activity"><option value="跑步">跑步</option><option value="步行">步行</option><option value="骑行">骑行</option><option value="运动">运动</option></select></label>
          <label>开始时间<input name="start" type="datetime-local" required></label>
          <label>结束时间<input name="end" type="datetime-local" required></label>
        </div>
        <button type="submit">评估活动天气</button>
      </form>
    </article>

    <article id="result" class="card result empty">查询结果会显示在这里。</article>
  </section>
</main>
<script>
  const result = document.getElementById("result");
  const escapeHtml = (value) => String(value ?? "暂无").replace(/[&<>"']/g, (char) => ({"&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#039;"}[char]));
  const valueOrNone = (value, suffix = "") => `${escapeHtml(value)}${suffix}`;
  const formData = (form) => Object.fromEntries(new FormData(form).entries());
  const locationPayload = (data) => ({
    latitude: Number(data.latitude),
    longitude: Number(data.longitude),
    source: "manual",
    ...(data.accuracy_m ? { accuracy_m: Number(data.accuracy_m) } : {})
  });
  const showError = (message) => {
    result.className = "card result";
    result.innerHTML = `<div class="notice">${escapeHtml(message)}</div>`;
  };
  const request = async (path, payload) => {
    result.className = "card result";
    result.innerHTML = "正在查询，请稍候……";
    try {
      const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail?.message || data.detail || "天气服务暂时不可用");
      return data;
    } catch (error) {
      showError(error.message);
      return null;
    }
  };
  const showCurrent = (data) => {
    const current = data.current;
    result.innerHTML = `<h2>当前天气：${escapeHtml(current.condition_text)}</h2>
      <div class="metric-grid">
        <div class="metric"><small>温度</small><strong>${valueOrNone(current.temperature_c, " ℃")}</strong></div>
        <div class="metric"><small>体感温度</small><strong>${valueOrNone(current.feels_like_c, " ℃")}</strong></div>
        <div class="metric"><small>湿度</small><strong>${valueOrNone(current.humidity_percent, " %")}</strong></div>
        <div class="metric"><small>降水概率</small><strong>${valueOrNone(current.precipitation_probability_percent, " %")}</strong></div>
        <div class="metric"><small>风速</small><strong>${valueOrNone(current.wind_speed_mps, " m/s")}</strong></div>
      </div><p>数据来源：${escapeHtml(data.source)} · 更新时间：${escapeHtml(data.fetched_at)}</p>${renderWarnings(data.warnings)}`;
  };
  const showForecast = (data) => {
    const rows = data.hours.slice(0, 24).map((hour) => `<tr><td>${escapeHtml(hour.forecast_time)}</td><td>${escapeHtml(hour.condition_text)}</td><td>${valueOrNone(hour.temperature_c, " ℃")}</td><td>${valueOrNone(hour.precipitation_probability_percent, " %")}</td><td>${valueOrNone(hour.wind_speed_mps, " m/s")}</td></tr>`).join("");
    result.innerHTML = `<h2>未来逐小时预报</h2><table><thead><tr><th>时间</th><th>天气</th><th>温度</th><th>降水概率</th><th>风速</th></tr></thead><tbody>${rows}</tbody></table><p>数据来源：${escapeHtml(data.source)} · 共返回 ${data.hours.length} 个时段</p>${renderWarnings(data.warnings)}`;
  };
  const showActivity = (data) => {
    const statusClass = data.status === "suitable" ? "good" : data.status === "caution" ? "caution" : "bad";
    result.innerHTML = `<h2>活动建议：<span class="${statusClass}">${escapeHtml(data.status_text)}</span></h2><p>活动类型：${escapeHtml(data.activity_text)} · 覆盖 ${data.forecast_hours_used} 个小时</p><ul>${data.reasons.map((reason) => `<li>${escapeHtml(reason)}</li>`).join("")}</ul>${renderWarnings(data.warnings)}`;
  };
  const renderWarnings = (warnings) => warnings?.length ? `<div class="notice">${warnings.map(escapeHtml).join("<br>")}</div>` : "";
  document.getElementById("current-form").addEventListener("submit", async (event) => { event.preventDefault(); const data = await request("/api/weather/current", locationPayload(formData(event.target))); if (data) showCurrent(data); });
  document.getElementById("forecast-form").addEventListener("submit", async (event) => { event.preventDefault(); const values = formData(event.target); const data = await request("/api/weather/forecast", { ...locationPayload(values), hours: Number(values.hours) }); if (data) showForecast(data); });
  document.getElementById("activity-form").addEventListener("submit", async (event) => { event.preventDefault(); const values = formData(event.target); const data = await request("/api/weather/outdoor-activity", { ...locationPayload(values), activity: values.activity, start: new Date(values.start).toISOString(), end: new Date(values.end).toISOString() }); if (data) showActivity(data); });
</script>
</body>
</html>"""


def get_chinese_docs() -> HTMLResponse:
    """Return the Chinese weather console."""

    return HTMLResponse(CHINESE_DOCS_HTML)
