/**
 * ============================================================================
 * dsh-server-auth 浏览器半侧（Web client bundle）
 * ============================================================================
 *
 * 将「账号与用户管理」无缝内嵌至 DSH 原生设置面板（settings.section 插槽）。
 * 只有管理员登录时可进行多账号增删改查；普通用户或未登录时提供清晰的安全状态提示。
 *
 * v0.10.0 追加：交付物文件卡片「下载」按钮（deliverables.file.actions 插槽）。
 * 见文件内「交付物卡片下载按钮」一节的依赖契约说明。
 */

window.__ModuleLoader__.load({
	id: 'dsh-postapi-bridge',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		// ============================================================================
		// v1.2.0 polyfill：兼容旧 WebView（安卓 App 内置浏览器）
		// ============================================================================
		//
		// 为什么需要：用户在安卓 App 的 WebView 里遇到 `AbortSignal.any is not a function`。
		//   该调用来自 **DSH 官方客户端**（@deepseek-ai/dsh-api-gateway 的 client 侧，
		//   packages/api/gateway/src/client/index.ts:480 等 271 处），不是本插件的代码。
		//   我们无法改官方源码，但可以在插件加载时**先把这些 API 补上**，
		//   让官方代码跑到时能正常工作。
		//
		// 为什么必须在这里（factory 最先几行）：
		//   必须早于任何 DSH 代码调用这些 API。factory 是插件模块的入口，
		//   而官方 UI bundle 的加载发生在其后，所以这里是可用的最早时机。
		//   注意不能放到 useEffect/apply 里 —— 那时官方代码可能已经跑过了。
		//
		// 全部带守卫：**已存在则不覆盖**（Node 26 / 新 Chrome 原生实现比这里更好）。
		// 日志走 console 直出（此时 DL_LOG 还没定义，且必须保证即使日志开关失效也能留痕）。
		var postapiPolyfilled = [];
		function __postapiTryPolyfill(name, install) {
			try {
				if (install()) {
					postapiPolyfilled.push(name);
					try { console.info('[dsh-postapi-download] polyfill: ' + name) } catch (eLog) {}
				}
			} catch (e) {
				// polyfill 本身失败绝不允许影响插件加载（宁可少补一个 API，也不能整页白屏）
				try { console.warn('[dsh-postapi-download] polyfill failed: ' + name, e) } catch (eLog) {}
			}
		}

		// ---- 1. AbortSignal.any(signals) ----
		// 语义（WHATWG）：返回一个 signal，任一入参 abort 时它同步 abort，reason 取该入参的 reason。
		// 易错点（都必须处理，否则行为与标准不一致）：
		//   a) 入参里**已有** aborted 的 signal → 必须立刻返回已 aborted 的结果（不能再等事件）；
		//   b) 空数组 / 无有效 signal → 永不 abort（不是立刻 abort）；
		//   c) 监听用 { once: true }，避免重复触发；
		//   d) 一旦 abort（无论哪路），要**移除其余监听器**，否则长期持有大量 signal 会泄漏；
		//   e) reason 透传：优先用入参 signal.reason；老环境没有 reason 属性时退回一个 AbortError。
		__postapiTryPolyfill('AbortSignal.any', function () {
			if (typeof AbortSignal === 'undefined') return false;
			if (typeof AbortSignal.any === 'function') return false;   // 原生优先，不覆盖
			var makeAbortError = function (msg) {
				try { return new DOMException(msg, 'AbortError') }
				catch (e) { var er = new Error(msg); er.name = 'AbortError'; return er }
			};
			var reasonOf = function (sig) {
				// Chrome 98+ 有 reason；更老的实现只有 aborted 布尔值
				if (sig && 'reason' in sig) return sig.reason;
				return makeAbortError('signal is aborted without reason');
			};
			AbortSignal.any = function (signals) {
				var controller = new AbortController();
				var list = [];
				// 容错：允许传入类数组；非可迭代输入按空处理（标准会抛 TypeError，但这里宽松更安全）
				try {
					if (signals != null) {
						for (var i = 0; i < signals.length; i++) {
							var s = signals[i];
							if (s && typeof s.addEventListener === 'function') list.push(s);
						}
					}
				} catch (eIter) { list = [] }

				// (a) 已有 aborted 的入参 → 立刻 abort，reason 取该入参
				for (var j = 0; j < list.length; j++) {
					if (list[j].aborted) {
						controller.abort(reasonOf(list[j]));
						return controller.signal;
					}
				}
				// (b) 空数组：永不 abort，直接返回（不注册任何监听）
				if (list.length === 0) return controller.signal;

				var cleanups = [];
			var stopped = false;   // v1.6.0：卸载后定时采样不再入队
				var onAbort = function (ev) {
					// (d) 清理其余监听器，防泄漏
					for (var k = 0; k < cleanups.length; k++) {
						try { cleanups[k]() } catch (eCl) {}
					}
					cleanups = [];
					// (e) reason 透传：优先取事件源的 reason，其次入参的 reason
					var src = (ev && ev.target) || null;
					controller.abort(src ? reasonOf(src) : makeAbortError('aborted'));
				};
				for (var m = 0; m < list.length; m++) {
					(function (sig) {
						// (c) once: true；保存解绑函数供 (d) 使用
						sig.addEventListener('abort', onAbort, { once: true });
						cleanups.push(function () {
							try { sig.removeEventListener('abort', onAbort) } catch (eR) {}
						});
					})(list[m]);
				}
				return controller.signal;
			};
			return true;
		});

		// ---- 2. AbortSignal.timeout(ms) ----
		// 语义：ms 后自动 abort，reason 是 TimeoutError（DOMException）。
		// 易错点：定时器要在**外层**注册（没有入参 signal 可供监听），且返回的 signal 不需要清理接口
		//   —— 标准也没提供取消方式，故这里保持简单（超时后自动 abort 一次）。
		__postapiTryPolyfill('AbortSignal.timeout', function () {
			if (typeof AbortSignal === 'undefined') return false;
			if (typeof AbortSignal.timeout === 'function') return false;
			AbortSignal.timeout = function (ms) {
				var controller = new AbortController();
				var delay = Number(ms);
				if (!isFinite(delay) || delay < 0) delay = 0;
				setTimeout(function () {
					var reason;
					try { reason = new DOMException('signal timed out', 'TimeoutError') }
					catch (e) { reason = new Error('signal timed out'); reason.name = 'TimeoutError' }
					controller.abort(reason);
				}, delay);
				return controller.signal;
			};
			return true;
		});

		// ---- 3. Promise.withResolvers() ----
		// 语义：返回 { promise, resolve, reject }，把三件套一次拿全。
		// 这是纯粹的语法糖，实现没有坑（注意必须把 resolve/reject 绑到同一个 promise）。
		__postapiTryPolyfill('Promise.withResolvers', function () {
			if (typeof Promise === 'undefined') return false;
			if (typeof Promise.withResolvers === 'function') return false;
			Promise.withResolvers = function () {
				var resolve, reject;
				var promise = new Promise(function (res, rej) { resolve = res; reject = rej });
				return { promise: promise, resolve: resolve, reject: reject };
			};
			return true;
		});

		// ---- 4. Array.prototype.at() ----
		// 语义：支持负索引（-1 = 最后一个），越界返回 undefined。
		// 注意：必须是 toInteger 截断（2.7 → 2，-0.5 → 0），直接 Math.floor 对负数会错。
		__postapiTryPolyfill('Array.prototype.at', function () {
			if (typeof Array.prototype === 'undefined') return false;
			if (typeof Array.prototype.at === 'function') return false;
			Object.defineProperty(Array.prototype, 'at', {
				value: function at(n) {
					var len = this.length >>> 0;
					if (len === 0) return undefined;
					var k = Math.trunc(Number(n));
					if (isNaN(k)) k = 0;
					if (k < 0) k += len;
					if (k < 0 || k >= len) return undefined;
					return this[k];
				},
				writable: true, configurable: true, enumerable: false,
			});
			return true;
		});

		// ---- 5. String.prototype.replaceAll() ----
		// 语义：全部替换。**关键差异**：传字符串时替换全部；传正则时**必须带 g 标志**，
		//   否则标准会抛 TypeError（这里保持同样的严格度，避免掩盖调用方的 bug）。
		__postapiTryPolyfill('String.prototype.replaceAll', function () {
			if (typeof String.prototype === 'undefined') return false;
			if (typeof String.prototype.replaceAll === 'function') return false;
			Object.defineProperty(String.prototype, 'replaceAll', {
				value: function replaceAll(searchValue, replaceValue) {
					var str = String(this);
					// 正则必须带 g，否则与标准一样抛错
					if (searchValue instanceof RegExp) {
						if (!searchValue.global) {
							throw new TypeError('replaceAll must be called with a global RegExp');
						}
						return str.replace(searchValue, replaceValue);
					}
					// 字符串：逐段替换（避免 replace 只换第一个）
					var needle = String(searchValue);
					if (needle === '') {
						// 空串的特殊语义：在每个字符之间插入（与标准一致）
						var out = '';
						var rep = typeof replaceValue === 'function' ? replaceValue : function () { return String(replaceValue) };
						for (var i = 0; i <= str.length; i++) {
							out += rep('', i, str);
							if (i < str.length) out += str.charAt(i);
						}
						return out;
					}
					// 非函数式替换：split/join 最快
					if (typeof replaceValue !== 'function') {
						return str.split(needle).join(String(replaceValue));
					}
					// 函数式替换：逐个匹配调用（与标准一致：参数为 (match, offset, string)）
					var res = '';
					var from = 0;
					var idx = str.indexOf(needle);
					while (idx !== -1) {
						res += str.slice(from, idx);
						res += String(replaceValue(needle, idx, str));
						from = idx + needle.length;
						idx = str.indexOf(needle, from);
					}
					res += str.slice(from);
					return res;
				},
				writable: true, configurable: true, enumerable: false,
			});
			return true;
		});

		// 供测试与排障：本次实际补了哪些 API
		try { window.__postapiPolyfilled = postapiPolyfilled.slice() } catch (eG) {}

		const React = require('react');
		const { useEffect, useState, useCallback, createElement: e } = React;

		// ============================================================================
		// ============================================================================
		// v1.4.0 客户端日志自动上报（用于远程诊断手机端卡顿）
		// ============================================================================
		//
		// 为什么需要：用户在安卓 App 的 WebView 里输入明显比桌面浏览器卡，但手机上
		//   拉不到 Console（没有 adb）。于是把「环境快照 + 长任务 + 掉帧 + 错误」批量
		//   飞到服务端（POST <apiPrefix>/client-log，该端点免鉴权，见 lib/index.js）。
		//
		// 🔴 v1.6.0 开关：**默认关闭**。优先级（高→低）：
		//     ① URL 参数 ?clientlog=on / off
		//     ② localStorage['dsh-postapi-client-log'] = 'on' / 'off'
		//     ③ 默认 → 关闭
		//   解析见 resolveClientLogEnabled()。⚠️ 前端**拿不到 config**（client entry 由宿主以
		//   { name } 创建，从不透传插件 config，见文件末尾 apiPrefix 处的同类说明）。
		//   改默认值的理由：v1.4.0 的采集器常驻 rAF 循环，用户实测 counterproductive
		//   （longtask 74 → 1048，FPS 掉到 1-5）。默认关闭 + ?clientlog=on 现场复查。
		//
		// 设计红线（每条都对应一个容易踩的坑）：
		//   ① **不污染 console**：console.error 包装后必须 apply 原函数、且自身绝不抛错；
		//   ② **回调里只 push**：PerformanceObserver / rAF 回调只入队，脱敏与序列化留到上报时，
		//      避免在主线程上做重活（长任务本来就是我们要查的问题，不能再自己造一个）；
		//   ③ **不常驻 rAF 循环**（v1.6.0）：帧率改为「每 5s 单次 rAF」量帧间隔，
		//      且页面不可见时跳过采样（后台页 rAF 被节流，量出来是假值）；
		//   ④ **失败静默、不重试**：fetch(...).catch(() => {}) —— 断网时不能引发重试雪崩；
		//   ⑤ **不阻塞页面**：fetch + keepalive，且不 await；
		//   ⑥ **不用 unload**（浏览器会丢弃异步请求），改用 visibilitychange → hidden；
		//   ⑦ **只传增量**：每条 entry 带自增 seq，上报成功后把 lastSentSeq 推到已发送的最大值，
		//      失败则不动（下次重发同一批，服务端按文件落盘，不会重复入队）。
		//
		// 队列上限：总队列 500 条（超出丢最旧的）。理由：一次 flush 上限 200 条，
		//   500 条足够覆盖连续几次失败的积压；无限增长会吃内存。
		// v1.6.0 追加：longtask 单独限长 100 条（用户实测 1048 条积压，会把其它条目挤掉）。

		var CL_MAX_QUEUE = 500                 // 总队列上限（上报前可持有多类条目）
		var CL_MAX_BATCH = 200                 // 与服务端 CLIENT_LOG_MAX_ENTRIES 对齐
		var CL_LONGTASK_MAX_QUEUE = 100        // v1.6.0：longtask 专用上限（超出丢最旧）
		var CL_FLUSH_INTERVAL_MS = 60000       // 每 60 秒上报一次增量（空队列不发请求）
		var CL_LONGTASK_MIN_MS = 100           // 只记 > 100ms 的长任务
		// ---- v1.6.0：CLS 聚合（不再每条 layout-shift 都入队）----
		var CL_CLS_EMIT_THRESHOLD = 0.1        // 累计无输入 CLS 达到 0.1 才写一条汇总
		var CL_CLS_EMIT_INTERVAL_MS = 10000    // 或距上次汇总满 10s 且有累计，也写一条
		// ---- v1.6.0：帧率低频采样（**不再是常驻 rAF 循环**）----
		var CL_FPS_SAMPLE_INTERVAL_MS = 5000   // 每 5s 采一帧（一次 rAF 往返，开销可忽略）
		var CL_FPS_BAD_MS = 150              // 单帧间隔 > 150ms（≈<7fps）才算「掉帧证据」
		var CL_FPS_REPORT_MIN_GAP_MS = 10000   // 两条 fps 记录至少间隔 10s（防刷屏）

		// 前缀固定为 default；config 拿不到（见上）。若改了后端 apiPrefix，改这里即可。
		var CL_ENDPOINT = '/api/dsh/v1/client-log'

		/**
		 * 创建采集器。**纯逻辑、可注入依赖**（测试友好）：
		 *   opts.now / opts.fetch / opts.document / opts.window / opts.setIntervalRef 可替换。
		 * 浏览器里 apply() 会传入真实对象；Node 测试里传桩。
		 *
		 * @returns {object} 采集器实例（记录、上报、安装、停止）
		 */
		function createClientLogCollector(opts) {
			var o = opts || {};
			var doc = o.document;
			var win = o.window;
			var nowFn = typeof o.now === 'function' ? o.now : function () { return Date.now() };
			var fetchFn = typeof o.fetch === 'function' ? o.fetch : (typeof win !== 'undefined' && win && typeof win.fetch === 'function' ? win.fetch.bind(win) : null);
			var endpoint = typeof o.endpoint === 'string' && o.endpoint ? o.endpoint : CL_ENDPOINT;

			var queue = [];          // [{seq, t, level, kind, duration, msg, extra?}]
			var seqCounter = 0;      // 只增不减
			var lastSentSeq = 0;     // 上报成功后推进
			var sentCount = 0;       // 测试/排障用
			var flushCount = 0;
			var stopped = false;

			/**
			 * 丢弃超出上限的**最旧**条目（原地 splice，避免再分配一个数组）。
			 * @param {Array} arr 队列
			 * @param {string|null} kind 只数指定 kind 的条目；null = 全队列
			 * @param {number} max 该 kind 的保留上限
			 */
			function dropOldest (arr, kind, max) {
				var count = 0;
				for (var i = 0; i < arr.length; i++) {
					if (!kind || arr[i].kind === kind) count += 1;
				}
				var excess = count - max;
				if (excess <= 0) return;
				// 从头部开始删：只有 kind 匹配（或 kind=null）的条目计入 excess，删够即停
				for (var j = 0; j < arr.length && excess > 0;) {
					if (!kind || arr[j].kind === kind) { arr.splice(j, 1); excess -= 1; }
					else j += 1;
				}
			}

			/** 入队一条。任何异常都不能冒泡（它跑在 console.error 包装里）。 */
			function push (entry) {
				try {
					if (stopped) return null;
					seqCounter += 1;
					var rec = {
						seq: seqCounter,
						t: nowFn(),
						level: typeof entry.level === 'string' ? entry.level : 'info',
						kind: typeof entry.kind === 'string' ? entry.kind : 'misc',
						duration: typeof entry.duration === 'number' && isFinite(entry.duration) ? Math.round(entry.duration) : null,
						msg: entry.msg === undefined || entry.msg === null ? '' : String(entry.msg),
					};
					if (entry.extra !== undefined) rec.extra = entry.extra;
					queue.push(rec);
					dropOldest(queue, null, CL_MAX_QUEUE);
					// v1.6.0：longtask 单独限长 100（用户实测 50 个日志文件里有 1048 条，
					//   既冲掉其它条目、又让上报体积膨胀）。丢最旧——最新卡顿才是现场证据。
					if (rec.kind === 'longtask') dropOldest(queue, 'longtask', CL_LONGTASK_MAX_QUEUE);
					return rec;
				} catch (e) {
					return null;
				}
			}

			/** 取「上次上报之后」的新条目（最多 CL_MAX_BATCH 条）。 */
			function pending () {
				var out = [];
				for (var i = 0; i < queue.length; i++) {
					if (queue[i].seq > lastSentSeq) out.push(queue[i]);
					if (out.length >= CL_MAX_BATCH) break;
				}
				return out;
			}

			/** 收集环境快照。所有字段都可能不存在（老 WebView），一律兜底。 */
			function envSnapshot () {
				var env = { screen: [], dpr: null, deviceMemory: null, hardwareConcurrency: null,
					supports: { webgl: false, compression: false } };
				try {
					if (win && win.screen) env.screen = [Number(win.screen.width) || 0, Number(win.screen.height) || 0];
					if (win && typeof win.devicePixelRatio === 'number') env.dpr = win.devicePixelRatio;
					if (win && win.navigator) {
						if (typeof win.navigator.deviceMemory === 'number') env.deviceMemory = win.navigator.deviceMemory;
						if (typeof win.navigator.hardwareConcurrency === 'number') env.hardwareConcurrency = win.navigator.hardwareConcurrency;
					}
				} catch (e1) {}
				// WebGL 支持：创建离屏 canvas 探针，用完立即释放（否则会占用一个 WebGL 上下文）
				try {
					if (doc && typeof doc.createElement === 'function') {
						var cv = doc.createElement('canvas');
						var gl = cv && typeof cv.getContext === 'function' ? (cv.getContext('webgl') || cv.getContext('experimental-webgl')) : null;
						env.supports.webgl = !!gl;
						var lose = gl && typeof gl.getExtension === 'function' ? gl.getExtension('WEBGL_lose_context') : null;
						if (lose && typeof lose.loseContext === 'function') lose.loseContext();
					}
				} catch (e2) { env.supports.webgl = false; }
				// CompressionStream：老 WebView 缺它会导致官方 bundle 某些路径报错，值得一看
				try { env.supports.compression = typeof win !== 'undefined' && !!win && typeof win.CompressionStream === 'function' } catch (e3) {}
				return env;
			}

			/** navigator.userAgent（关键：能看出 WebView 内核版本） */
			function uaOf () {
				try { return win && win.navigator && typeof win.navigator.userAgent === 'string' ? win.navigator.userAgent : '' } catch (e) { return '' }
			}

			/**
			 * 上报一批。**永不抛错、永不重试、永不 await 调用方**。
			 * @param {string} kind snapshot|perf|error|flush
			 * @param {Array}  entries 显式条目（snapshot/error 用）；不传则取 pending()
			 * @param {boolean} markSent 成功后是否推进 lastSentSeq
			 * @returns {Promise<{ok:boolean, skipped?:string}>}  仅供测试观察，业务侧忽略
			 */
			function report (kind, entries, markSent) {
				var batch = Array.isArray(entries) ? entries.slice() : pending();
				if (batch.length === 0) return Promise.resolve({ ok: true, skipped: 'empty' });
				if (!fetchFn) return Promise.resolve({ ok: false, skipped: 'no-fetch' });
				var maxSeq = 0;
				var wireEntries = [];
				for (var i = 0; i < batch.length; i++) {
					var b = batch[i];
					if (b.seq && b.seq > maxSeq) maxSeq = b.seq;
					var item = { t: b.t, level: b.level, kind: b.kind };
					if (typeof b.duration === 'number') item.duration = b.duration;
					item.msg = b.msg;
					if (b.extra !== undefined) item.extra = b.extra;
					wireEntries.push(item);
				}
				var payload = {
					source: 'web',
					kind: kind,
					ua: uaOf(),
					env: envSnapshot(),
					entries: wireEntries,
				};
				flushCount += 1;
				// ⚠️ keepalive: true 让请求在页面隐藏/关闭后仍能完成（但**不依赖 unload**）
				// ⚠️ 不带鉴权头：端点免鉴权，不读也不发 cookie/token（浏览器默认同源策略即可）
				var p = null;
				try {
				// ⚠️ 刻意省略 credentials：本端点免鉴权（见 README「客户端日志自动上报」），
				//    且此处的 fetch 是**可注入的**（fetchFn），浏览器里等价于默认 same-origin。
					p = fetchFn(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), keepalive: true });
				} catch (e) {
					return Promise.resolve({ ok: false, skipped: 'throw' });
				}
				return Promise.resolve(p).then(function (res) {
					var ok = !!(res && res.ok);
					if (ok) {
						sentCount += batch.length;
						if (markSent !== false && maxSeq > lastSentSeq) lastSentSeq = maxSeq;
					}
					// 失败：**不重试、不改 lastSentSeq**（这批下次 flush 会重发，不会丢）
					return { ok: ok, status: res && res.status };
				}).catch(function () {
					// 网络层异常：静默（断网时不能引发重试雪崩）
					return { ok: false, skipped: 'network' };
				});
			}

			/** 定时 flush：只发增量；空则不发请求。 */
			function flush () {
				var batch = pending();
				if (batch.length === 0) return Promise.resolve({ ok: true, skipped: 'empty' });
				return report('flush', batch, true);
			}

			return {
				push: push,
				pending: pending,
				report: report,
				flush: flush,
				envSnapshot: envSnapshot,
				queue: queue,
				stats: function () { return { queued: queue.length, lastSentSeq: lastSentSeq, sent: sentCount, flushes: flushCount, seqCounter: seqCounter }; },
				stop: function () { stopped = true; },
				// 仅供测试：直接设 lastSentSeq（模拟"已发过"）
				__setLastSentSeq: function (n) { lastSentSeq = n; },
			};
		}

		/**
		 * v1.6.0：解析「是否启用客户端日志采集」。**默认关闭**。
		 *
		 * 优先级（从高到低）：
		 *   ① URL 参数 ?clientlog=on / off     —— 现场临时开关，刷新即生效，不用改任何存储
		 *   ② localStorage['dsh-postapi-client-log'] = 'on' / 'off'  —— 持久化开关
		 *   ③ 默认 → 关闭
		 *
		 * 为什么默认关闭：v1.4.0 打开采集后用户实测更卡（longtask 74 → 1048，FPS 掉到 1-5）。
		 *   诊断能力不能以牺牲常态性能为代价 —— 这正是「默认关 + 可现场打开」的理由。
		 *
		 * 为什么 URL 优先于 localStorage：localStorage 是「跨会话的默认值」，URL 是「这一次」。
		 *   现场排查时用户只需把链接加上 ?clientlog=on，无需开控制台（手机上没有 adb/控制台），
		 *   也不会因为忘了改回来而长期开着采集。
		 *
		 * 任何读取异常（隐私模式禁用 localStorage、伪造 location）一律**按关闭处理**：
		 *   宁可少一份诊断日志，也不要在拿不到用户意图时偷偷跑采集器。
		 *
		 * @param {object} [env] { search, storage } （均可注入，便于测试）
		 * @returns {{ enabled: boolean, source: string }} source: 'url'|'storage'|'default'|'config'
		 */
		function resolveClientLogEnabled (env) {
			var e = env || {};
			var KEY = 'dsh-postapi-client-log';
			// ① URL 参数
			try {
				var search = typeof e.search === 'string' ? e.search : null;
				if (search === null) {
					search = (typeof location !== 'undefined' && location && typeof location.search === 'string')
						? location.search
						: (typeof window !== 'undefined' && window && window.location && typeof window.location.search === 'string' ? window.location.search : '');
				}
				var m = /[?&]clientlog=([^&]*)/i.exec(search || '');
				if (m) {
					var v = String(m[1] || '').toLowerCase();
					// 兼容 on/1/true/yes 与 off/0/false/no；其它值视为「未表态」，继续往下看存储
					if (v === 'on' || v === '1' || v === 'true' || v === 'yes') return { enabled: true, source: 'url' };
					if (v === 'off' || v === '0' || v === 'false' || v === 'no') return { enabled: false, source: 'url' };
				}
			} catch (eUrl) {}
			// ② localStorage
			try {
				var st = e.storage;
				if (st === undefined) st = (typeof localStorage !== 'undefined' ? localStorage : null);
				if (st && typeof st.getItem === 'function') {
					var sv = st.getItem(KEY);
					if (sv === 'on') return { enabled: true, source: 'storage' };
					if (sv === 'off') return { enabled: false, source: 'storage' };
				}
			} catch (eLs) {}
			// ③ 默认关闭
			return { enabled: false, source: 'default' };
		}

		/** 供测试 import（浏览器运行时也会挂上，无副作用） */
		var __clientLogHelpers = {
			createClientLogCollector: createClientLogCollector,
			CL_MAX_QUEUE: CL_MAX_QUEUE, CL_MAX_BATCH: CL_MAX_BATCH,
			CL_FLUSH_INTERVAL_MS: CL_FLUSH_INTERVAL_MS,
			CL_LONGTASK_MIN_MS: CL_LONGTASK_MIN_MS, CL_ENDPOINT: CL_ENDPOINT,
			// v1.6.0：低频帧率采样 + CLS 聚合 + longtask 限长
			CL_LONGTASK_MAX_QUEUE: CL_LONGTASK_MAX_QUEUE,
			CL_CLS_EMIT_THRESHOLD: CL_CLS_EMIT_THRESHOLD, CL_CLS_EMIT_INTERVAL_MS: CL_CLS_EMIT_INTERVAL_MS,
			CL_FPS_SAMPLE_INTERVAL_MS: CL_FPS_SAMPLE_INTERVAL_MS, CL_FPS_BAD_MS: CL_FPS_BAD_MS,
			CL_FPS_REPORT_MIN_GAP_MS: CL_FPS_REPORT_MIN_GAP_MS,
			resolveClientLogEnabled: resolveClientLogEnabled,

		};
		/**
		 * 把采集器装到真实页面上（apply 里调用一次）。**全程 try/catch**：
		 * 这是诊断辅助能力，任何失败都不得影响插件其余部分（尤其不能白屏）。
		 *
		 * 采集项与阈值：
		 *   (a) snapshot —— 立即上报一次环境快照；
		 *   (b) longtask —— PerformanceObserver(['longtask'])，只记 > 100ms；
		 *   (c) fps      —— rAF 采样，FPS < 30 **持续 2 秒**才记一条；
		 *   (d) first-input / layout-shift —— FID 与 CLS；
		 *   (e) error    —— window.onerror / unhandledrejection / console.error 包装，立即上报；
		 *   (f) flush    —— 每 60s 或 visibilitychange→hidden 时上报增量。
		 */
		function installClientLogAutoReport(collector, thresholds) {
			// 阈值可注入：浏览器里 apply() 不传 → 用模块常量；测试里可显式传，避免依赖闭包。
			var TH = thresholds || {};
			// 默认值来自模块常量（浏览器路径）；测试可显式注入同名数值。
			var LONG_TASK_MIN = typeof TH.longTaskMinMs === 'number' ? TH.longTaskMinMs : CL_LONGTASK_MIN_MS;
			// v1.6.0：帧率改为低频采样，旧的三项（窗口/阈值/持续秒数）不再需要。
			//   fpsSampleIntervalMs —— 两次采样的间隔（默认 5s，测试可压到 10ms）
			//   fpsBadMs           —— 单帧间隔超过它就记一条（默认 150ms ≈ <7fps）
			//   fpsReportMinGapMs  —— 两条 fps 记录的最小间隔（默认 10s，防刷屏）
			//   clsEmitThreshold   —— CLS 累计到多少写一条汇总（默认 0.1）
			//   clsEmitIntervalMs  —— CLS 汇总窗口（默认 10s）
			var FPS_SAMPLE_INTERVAL = typeof TH.fpsSampleIntervalMs === 'number' ? TH.fpsSampleIntervalMs : CL_FPS_SAMPLE_INTERVAL_MS;
			var FPS_BAD_MS = typeof TH.fpsBadMs === 'number' ? TH.fpsBadMs : CL_FPS_BAD_MS;
			var FPS_REPORT_MIN_GAP = typeof TH.fpsReportMinGapMs === 'number' ? TH.fpsReportMinGapMs : CL_FPS_REPORT_MIN_GAP_MS;
			var CLS_EMIT_THRESHOLD = typeof TH.clsEmitThreshold === 'number' ? TH.clsEmitThreshold : CL_CLS_EMIT_THRESHOLD;
			var CLS_EMIT_INTERVAL = typeof TH.clsEmitIntervalMs === 'number' ? TH.clsEmitIntervalMs : CL_CLS_EMIT_INTERVAL_MS;
			var FLUSH_MS = typeof TH.flushIntervalMs === 'number' ? TH.flushIntervalMs : CL_FLUSH_INTERVAL_MS;
			// 安装器内的「当前时间」：测试可注入假时钟，浏览器走 Date.now
			var nowMs = typeof TH.now === 'function' ? TH.now : function () { return Date.now() };
			var cleanups = [];
			var win = typeof window === 'undefined' ? undefined : window;
			var doc = typeof document === 'undefined' ? undefined : document;
			if (!win || !doc || !collector) return function () {};

			// ---- (f) 定时 flush + 页面隐藏时 flush ----
			var timer = null;
			try {
				timer = win.setInterval(function () { try { collector.flush() } catch (e) {} }, FLUSH_MS);
				cleanups.push(function () { try { win.clearInterval(timer) } catch (e) {} });
			} catch (e0) {}
			try {
				var onVis = function () {
					try { if (doc.visibilityState === 'hidden') collector.flush() } catch (e) {}
				};
				// ⚠️ 用 visibilitychange 而**不是** unload/beforeunload：浏览器会丢弃 unload 里的
				//    异步请求；visibilitychange→hidden 仍允许 keepalive 请求完成。
				doc.addEventListener('visibilitychange', onVis);
				cleanups.push(function () { try { doc.removeEventListener('visibilitychange', onVis) } catch (e) {} });
			} catch (e1) {}

			// ---- (b)(d) PerformanceObserver ----
			// ⚠️ 回调里**只做最轻的记账**：长任务本身说明主线程紧张，回调里再做序列化就是雪上加霜。
			try {
				if (typeof win.PerformanceObserver === 'function') {
					var observe = function (types, handler) {
						try {
							var po = new win.PerformanceObserver(function (list) {
								try {
									var items = list && typeof list.getEntries === 'function' ? list.getEntries() : [];
									for (var i = 0; i < items.length; i++) handler(items[i]);
								} catch (eH) {}
							});
							po.observe({ entryTypes: types });
							cleanups.push(function () { try { po.disconnect() } catch (e) {} });
						} catch (eO) {}
					};
					// 长任务：> 100ms 才算（<100ms 是常态噪音，会把队列冲掉）。
					// v1.6.0：这是**最有价值的诊断信息**，保留采集；但队列只留最近 100 条
					//   （见 createClientLogCollector.push → CL_LONGTASK_MAX_QUEUE）。
					observe(['longtask'], function (entry) {
						var d = Number(entry && entry.duration);
						if (!isFinite(d) || d <= LONG_TASK_MIN) return;
						collector.push({ level: 'warn', kind: 'longtask', duration: d,
							msg: 'longtask ' + Math.round(d) + 'ms' + (entry && entry.name ? ' (' + entry.name + ')' : '') });
					});
					// 首次输入延迟（FID）：只记第一条，超过 100ms 才算有意义
					observe(['first-input'], function (entry) {
						var d = Number(entry && entry.processingStart) && Number(entry.startTime)
							? Number(entry.processingStart) - Number(entry.startTime) : Number(entry && entry.duration);
						collector.push({ level: 'info', kind: 'fid', duration: isFinite(d) ? d : null,
							msg: 'first-input delay ' + (isFinite(d) ? Math.round(d) + 'ms' : 'unknown') });
					});
					// 布局偏移（CLS）：**v1.6.0 改为聚合**。
					//   旧实现每条 layout-shift 都 push —— 用户日志里 cls 436 条，抖动页面上
					//   这等于持续制造对象、持续占队列。现在只在内存里累加一个 number，
					//   满足「累计 >= 0.1」或「窗口到期(10s)」才写一条汇总。
					//   hadRecentInput=true（用户输入引起的偏移）不计入 CLS，与官方算法一致。
					var clsAcc = 0;          // 本次窗口内累计的无输入偏移
					var clsShifts = 0;       // 本次窗口内的 shift 次数
					var clsWindowStart = 0;  // 窗口起点（0 = 尚无数据）
					var clsMaxSingle = 0;    // 窗口内单次最大值（区分"一次大跳"与"多次小抖"）
					var flushCls = function (force) {
						try {
							if (!clsShifts) return;
							var elapsed = clsWindowStart ? (nowMs() - clsWindowStart) : CLS_EMIT_INTERVAL;
							// 未达阈值时，只有"窗口到期"才落一条；force（卸载）也落，避免丢尾巴
							if (!force && clsAcc < CLS_EMIT_THRESHOLD && elapsed < CLS_EMIT_INTERVAL) return;
							collector.push({ level: clsAcc >= CLS_EMIT_THRESHOLD ? 'warn' : 'info', kind: 'cls',
								duration: Math.round(clsAcc * 10000) / 10000,
								msg: 'cls ' + (Math.round(clsAcc * 10000) / 10000) + ' over ' + Math.round(elapsed) + 'ms ('
									+ clsShifts + ' shifts, max ' + (Math.round(clsMaxSingle * 10000) / 10000) + ')' });
						} catch (eC1) {}
						clsAcc = 0; clsShifts = 0; clsMaxSingle = 0; clsWindowStart = 0;
					};
					observe(['layout-shift'], function (entry) {
						var v = Number(entry && entry.value);
						if (!isFinite(v) || v <= 0) return;
						if (entry && entry.hadRecentInput) return;  // 用户输入引起的偏移不计入 CLS
						clsAcc += v;
						clsShifts += 1;
						if (v > clsMaxSingle) clsMaxSingle = v;
						if (!clsWindowStart) clsWindowStart = nowMs();
						if (clsAcc >= CLS_EMIT_THRESHOLD) flushCls(false);
					});
					// 窗口到期检查（10s 一次，定时器本身开销可忽略）+ 卸载时兜底落盘
					try {
						var clsTimer = win.setInterval(function () { try { flushCls(false) } catch (eC2) {} }, CLS_EMIT_INTERVAL);
						cleanups.push(function () { try { win.clearInterval(clsTimer) } catch (e) {} });
					} catch (eCT) {}
					cleanups.push(function () { try { flushCls(true) } catch (e) {} });
					// 不可见时把已累计的 CLS 落一条（后台页不会再有 shift，留着也是丢）
					try {
						var onVisCls = function () {
							try { if (doc.visibilityState === 'hidden') flushCls(false) } catch (e) {}
						};
						doc.addEventListener('visibilitychange', onVisCls);
						cleanups.push(function () { try { doc.removeEventListener('visibilitychange', onVisCls) } catch (e) {} });
					} catch (eV0) {}
				}
			} catch (e2) {}

			// ---- (c) 帧率：低频采样（v1.6.0 移除常驻 rAF 循环）----
			//
			// 🔴 旧实现是**每帧** requestAnimationFrame(tick) 自循环，用于统计 FPS。
			//   用户实测暴露了它的恶性循环：页面卡 → FPS 掉到 1-5 → 每帧仍要跑 tick
			//   → tick 自身有开销 → 更卡。50 个日志里 longtask 从 74 涨到 1048。
			//   诊断能力不能以牺牲常态性能为代价 ⇒ 这条自循环**整段删除**。
			//
			// 新做法：每 CL_FPS_SAMPLE_INTERVAL_MS 用定时器**单次**排一个 rAF，
			//   量「相邻两次采样帧的时间差」= 此刻的帧间隔。开销：每 5 秒一次 rAF 往返，
			//   可忽略；而它天然反映「主线程被阻塞到什么程度」——
			//   间隔 > 150ms（≈<7fps）就是用户体感卡顿的直接证据。
			// 不再统计「1 秒 N 帧」：那必须持续 rAF，正是旧实现的问题。
			try {
				if (typeof win.requestAnimationFrame === 'function' && typeof win.setInterval === 'function'
					&& typeof FPS_SAMPLE_INTERVAL === 'number' && FPS_SAMPLE_INTERVAL > 0) {
					var fpsLastFrameTs = 0;   // 上一次采样的帧时间戳
					var fpsPending = false;   // 已排了一帧、等回调（避免堆积）
					var fpsLastReport = 0;    // 上次写 fps 记录的时间（防刷屏）
					var sampleFrame = function (ts) {
						fpsPending = false;
						try {
							var t = typeof ts === 'number' && isFinite(ts) ? ts : nowMs();
							if (fpsLastFrameTs > 0) {
								var gap = t - fpsLastFrameTs;
								var quiet = (nowMs() - fpsLastReport) >= FPS_REPORT_MIN_GAP;
								// gap <= 0（时间基准切换/伪造时间戳）视为无效
								if (gap > 0 && gap >= FPS_BAD_MS && quiet) {
									fpsLastReport = nowMs();
									collector.push({ level: 'warn', kind: 'fps', duration: Math.round(gap),
										msg: 'frame gap ' + Math.round(gap) + 'ms (~' + Math.max(1, Math.round(1000 / gap)) + 'fps)' });
								}
							}
							fpsLastFrameTs = t;
						} catch (eF) {}
					};
					var sampleOnce = function () {
						try {
							if (stopped || fpsPending) return;
							if (doc.visibilityState === 'hidden') return;  // 后台页 rAF 被节流，量出来是假值
							fpsPending = true;
							win.requestAnimationFrame(sampleFrame);
						} catch (eS) {}
					};
					var fpsTimer = win.setInterval(sampleOnce, FPS_SAMPLE_INTERVAL);
					cleanups.push(function () { try { win.clearInterval(fpsTimer) } catch (e) {} });
					sampleOnce();
				}
			} catch (e4) {}

			// ---- (e) 异常：立刻上报 ----
			var reportError = function (msg, extra) {
				try {
					var rec = collector.push({ level: 'error', kind: 'error', msg: msg, extra: extra });
					// 立即上报（单条也发）：错误是现场证据，攒 60 秒可能就再也等不到下一个 flush
					collector.report('error', rec ? [rec] : [], true);
				} catch (e) {}
			};
			try {
				var onErr = function (ev) {
					try {
						var m = ev && ev.message ? String(ev.message) : 'window.onerror';
						var where = ev && ev.filename ? String(ev.filename) + ':' + (ev.lineno || 0) : '';
						reportError(m + (where ? ' @ ' + where : ''), { source: 'window.onerror' });
					} catch (eE) {}
				};
				win.addEventListener('error', onErr);
				cleanups.push(function () { try { win.removeEventListener('error', onErr) } catch (e) {} });
			} catch (e5) {}
			try {
				var onRej = function (ev) {
					try {
						var r = ev && ev.reason;
						var text = r && r.message ? String(r.message) : String(r);
						reportError('unhandledrejection: ' + text.slice(0, 500), { source: 'unhandledrejection' });
					} catch (eR2) {}
				};
				win.addEventListener('unhandledrejection', onRej);
				cleanups.push(function () { try { win.removeEventListener('unhandledrejection', onRej) } catch (e) {} });
			} catch (e6) {}

			// ---- (e) console.error 包装 ----
			// 🔴 三条硬要求：
			//   ① **保留原行为** —— 用 apply 原函数，参数原样透传，且把返回值原样返回；
			//   ② **绝不抛错** —— 采集失败不影响控制台输出（否则会让"报错"变成"报错更严重"）；
			//   ③ **可还原** —— 保存原函数并挂 __postapiOriginal，cleanup 时恢复。
			try {
				if (win.console && typeof win.console.error === 'function' && !win.console.error.__postapiWrapped) {
					var origErr = win.console.error;
					var wrapped = function () {
						var args = arguments;
						// 先记录（用 try 包死），再无条件调用原函数
						try {
							var parts = [];
							for (var i = 0; i < args.length && i < 5; i++) {
								var a = args[i];
								if (typeof a === 'string') parts.push(a);
								else if (a instanceof Error) parts.push(String(a && a.message ? a.message : a));
								else { try { parts.push(JSON.stringify(a)) } catch (eJ) { parts.push(String(a)) } }
							}
							var rec = collector.push({ level: 'error', kind: 'console.error', msg: parts.join(' ') });
							collector.report('error', rec ? [rec] : [], true);
						} catch (eC) {}
						return origErr.apply(win.console, args);
					};
					wrapped.__postapiWrapped = true;
					wrapped.__postapiOriginal = origErr;
					win.console.error = wrapped;
					cleanups.push(function () {
						try { if (win.console && win.console.error === wrapped) win.console.error = origErr } catch (e) {}
					});
				}
			} catch (e7) {}

			return function uninstall() {
				stopped = true;
				try { collector.stop() } catch (e) {}
				for (var i = cleanups.length - 1; i >= 0; i--) { try { cleanups[i]() } catch (e) {} }
				cleanups.length = 0;
			};
		}

		// ============================================================================
		// v0.11.1 诊断日志（临时排查能力，长期保留但可一键关闭）
		// ============================================================================
		// 为什么需要：20261022 线上只能看到「文件资源不可用」这类官方文案，无法判断
		//   A：我们的下载按钮在，只是官方 available=false 的提示也在（文案误导，功能正常）
		//   B：下载按钮根本没渲染（本插件 slot 没进、或 actionUrl 解析失败）
		// 两者在 UI 上表现一样，只能靠 console 日志区分。
		//
		// 开关策略：**默认开启**（正处于排查期），用户/运维可在控制台执行
		//   localStorage.setItem('dsh-postapi-download-log', 'off')
		// 后刷新页面关闭，避免长期刷屏。读取失败（隐私模式禁用 localStorage）时默认开启。
		const DL_LOG = (() => {
			try { return localStorage.getItem('dsh-postapi-download-log') !== 'off'; }
			catch (err) { return true; }
		})();

		const DL_LOG_PREFIX = '[dsh-postapi-download]';

		/**
		 * 统一日志出口。**所有下载相关日志都必须经这里**，好处：
		 *   ① 开关只在一个地方判断；
		 *   ② console 本身被扩展/环境打挂时不会抛错影响按钮渲染。
		 */
		function dlLog(kind, message, detail) {
			if (!DL_LOG) return;
			try {
				const fn = kind === 'warn' ? console.warn : console.info;
				if (detail === undefined) fn(DL_LOG_PREFIX + ' ' + message);
				else fn(DL_LOG_PREFIX + ' ' + message, detail);
			} catch (err) {}
		}

		/**
		 * 把带 token 的下载地址**打码**后再用于日志。
		 *
		 * 安全边界（硬要求）：token 是 bearer 式凭据，一旦进 console 就会被截图/贴给
		 * 第三方或落到日志采集里。故日志里**只保留 path 前两段 + token 前后各 4 位**，
		 * 例如 /api/dsh/v1/file/ab12****************9f3c。
		 * 这样排查时足以判断「地址形态对不对、是不是同一个」，但拿不到可用凭据。
		 *
		 * 注意：不直接对整串 url 做 console.log —— 静态断言会检查这一点。
		 */
		function maskDownloadUrl(rawUrl) {
			try {
				const u = new URL(String(rawUrl), (typeof location !== 'undefined' && location.origin) || 'http://localhost');
				const parts = u.pathname.split('/').filter(Boolean);
				const last = parts[parts.length - 1] || '';
				const head = last.slice(0, 4);
				const tail = last.slice(-4);
				const masked = last.length <= 12 ? '****' : (head + '****************' + tail);
				parts[parts.length - 1] = masked;
				return '/' + parts.join('/');
			} catch (err) {
				return '<unparsable-url>';
			}
		}


		// ============================================================================
		// 内联 CSS 样式注入（自适应 DSH 浅色与暗黑模式）
		// ============================================================================
		const css = `
			.dsa-section-root { display: flex; flex-direction: column; gap: 16px; padding: 4px 0; font-family: system-ui, -apple-system, sans-serif; }
			.dsa-card { background: var(--dsw-card-bg, #ffffff); border: 1px solid var(--dsw-border, #e5e7eb); border-radius: 12px; padding: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.05); }
			.dsa-title { font-size: 16px; font-weight: 600; margin: 0 0 4px 0; color: var(--dsw-text-main, #111827); }
			.dsa-desc { font-size: 13px; color: var(--dsw-text-sub, #6b7280); margin: 0 0 16px 0; }
			
			.dsa-form-grid { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
			.dsa-input { padding: 8px 12px; border: 1px solid var(--dsw-border, #d1d5db); border-radius: 8px; font-size: 13px; background: var(--dsw-input-bg, #ffffff); color: var(--dsw-text-main, #111827); outline: none; transition: border-color 0.2s; }
			.dsa-input:focus { border-color: #3b82f6; }
			.dsa-select { padding: 8px 12px; border: 1px solid var(--dsw-border, #d1d5db); border-radius: 8px; font-size: 13px; background: var(--dsw-input-bg, #ffffff); color: var(--dsw-text-main, #111827); cursor: pointer; }
			
			.dsa-btn { padding: 8px 16px; border: 0; border-radius: 8px; font-size: 13px; font-weight: 500; cursor: pointer; transition: opacity 0.15s, transform 0.05s; display: inline-flex; align-items: center; justify-content: center; gap: 6px; }
			.dsa-btn:active { transform: scale(0.98); }
			.dsa-btn:disabled { opacity: 0.5; cursor: not-allowed; }
			.dsa-btn-primary { background: #2563eb; color: #ffffff; }
			.dsa-btn-primary:hover { background: #1d4ed8; }
			.dsa-btn-sm { padding: 4px 10px; font-size: 12px; border-radius: 6px; }
			.dsa-btn-outline { background: transparent; border: 1px solid var(--dsw-border, #d1d5db); color: var(--dsw-text-main, #374151); }
			.dsa-btn-outline:hover { background: var(--dsw-hover-bg, #f3f4f6); }
			.dsa-btn-danger { background: transparent; border: 1px solid #fca5a5; color: #ef4444; }
			.dsa-btn-danger:hover { background: #fef2f2; }
			
			.dsa-table-wrap { overflow-x: auto; border: 1px solid var(--dsw-border, #e5e7eb); border-radius: 8px; margin-top: 12px; }
			.dsa-table { width: 100%; border-collapse: collapse; text-align: left; font-size: 13px; }
			.dsa-table th { background: var(--dsw-th-bg, #f9fafb); padding: 10px 14px; font-weight: 600; color: var(--dsw-text-sub, #4b5563); border-bottom: 1px solid var(--dsw-border, #e5e7eb); }
			.dsa-table td { padding: 12px 14px; border-bottom: 1px solid var(--dsw-border, #f3f4f6); color: var(--dsw-text-main, #1f2937); }
			.dsa-table tr:last-child td { border-bottom: 0; }
			.dsa-table tr:hover td { background: var(--dsw-hover-bg, #f9fafb); }
			
			.dsa-badge { display: inline-flex; align-items: center; padding: 2px 8px; border-radius: 9999px; font-size: 11px; font-weight: 500; }
			.dsa-badge-admin { background: #dbeafe; color: #1e40af; }
			.dsa-badge-user { background: #f3f4f6; color: #4b5563; }
			.dsa-badge-enabled { background: #dcfce7; color: #166534; }
			.dsa-badge-disabled { background: #fee2e2; color: #991b1b; }
			
			.dsa-msg { padding: 8px 12px; border-radius: 6px; font-size: 13px; margin-top: 8px; }
			.dsa-msg-ok { background: #dcfce7; color: #166534; }
			.dsa-msg-err { background: #fee2e2; color: #991b1b; }
			
			/* 暗黑模式适配 */
			body[data-ds-dark-theme] .dsa-card { --dsw-card-bg: #1e1e20; --dsw-border: #333336; }
			body[data-ds-dark-theme] .dsa-title { --dsw-text-main: #f3f4f6; }
			body[data-ds-dark-theme] .dsa-desc { --dsw-text-sub: #9ca3af; }
			body[data-ds-dark-theme] .dsa-input, body[data-ds-dark-theme] .dsa-select { --dsw-input-bg: #141416; --dsw-border: #444448; --dsw-text-main: #f9fafb; }
			body[data-ds-dark-theme] .dsa-table { --dsw-border: #333336; }
			body[data-ds-dark-theme] .dsa-table th { --dsw-th-bg: #27272a; --dsw-text-sub: #a1a1aa; }
			body[data-ds-dark-theme] .dsa-table td { --dsw-text-main: #e4e4e7; border-color: #27272a; }
			body[data-ds-dark-theme] .dsa-table tr:hover td { --dsw-hover-bg: #27272a; }
			body[data-ds-dark-theme] .dsa-btn-outline { --dsw-border: #444448; --dsw-text-main: #d1d5db; }
			body[data-ds-dark-theme] .dsa-btn-outline:hover { --dsw-hover-bg: #2d2d30; }
			body[data-ds-dark-theme] .dsa-btn-danger:hover { background: #451a1a; }
			body[data-ds-dark-theme] .dsa-badge-admin { background: #1e3a8a; color: #93c5fd; }
			body[data-ds-dark-theme] .dsa-badge-user { background: #27272a; color: #a1a1aa; }
			body[data-ds-dark-theme] .dsa-badge-enabled { background: #14532d; color: #86efac; }
			body[data-ds-dark-theme] .dsa-badge-disabled { background: #7f1d1d; color: #fca5a5; }

			/* ---- v0.10.0 交付物卡片「下载」按钮 ----
			 * 尺寸对标官方 ui-open-in-app 的文件操作按钮（24px 高、0.5px 描边、11px 字），
			 * 因为它和 open/reveal 并排坐在同一处 .actions 区里，比其他 dsa-btn 更小一号。
			 * 颜色全部走官方 --dsw-alias-* 语义 token（自带暗黑模式），
			 * --dsw-* 自定义变量兜底只为本文件既有的 dsa 风格服务。 */
			.dsa-dl {
				display: inline-flex; flex: none; align-items: center; justify-content: center; gap: 4px;
				box-sizing: border-box; height: 24px; padding: 0 9px;
				border: 0.5px solid var(--dsw-alias-border-l2, var(--dsw-border, #d1d5db));
				border-radius: 9px; background: transparent;
				color: var(--dsw-alias-label-primary, var(--dsw-text-main, #111827));
				font-family: var(--dsw-font-family, system-ui, -apple-system, sans-serif);
				font-size: 11px; line-height: 16px; white-space: nowrap;
				cursor: pointer; transition: background-color 120ms ease, border-color 120ms ease;
			}
			.dsa-dl:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, var(--dsw-hover-bg, #f3f4f6)); }
			.dsa-dl:focus-visible { outline: none; box-shadow: inset 0 0 0 2px var(--dsw-alias-brand-primary, #3b82f6); }
			/* 在途/禁用：只降视觉权重，不改尺寸 —— 避免卡片行高在点击瞬间跳动 */
			.dsa-dl:disabled { cursor: not-allowed; opacity: 0.55; }
			/* 失败态：语义色描边 + 文字，悬停恢复中性描边以提示「可重试」 */
			.dsa-dl[data-state="error"] {
				border-color: var(--dsw-alias-state-error-primary, #ef4444);
				color: var(--dsw-alias-state-error-primary, #ef4444);
				opacity: 1;
			}
			.dsa-dl[data-state="error"]:hover:not(:disabled) { background: transparent; }
			/* 加载指示：纯 CSS 小圆环，不引依赖（极简主义） */
			.dsa-dl-spin {
				display: inline-block; flex: none; width: 10px; height: 10px;
				border: 1.5px solid currentColor; border-right-color: transparent;
				border-radius: 50%; animation: dsa-dl-rotate 0.7s linear infinite;
			}
			@keyframes dsa-dl-rotate { to { transform: rotate(360deg); } }
			/* 尊重系统「减少动态效果」偏好 */
			@media (prefers-reduced-motion: reduce) { .dsa-dl-spin { animation: none; } }

			/* ---- v1.1.0 交付物入口：紧凑按钮 + 右侧抽屉 ----
			 *
			 * 为什么是抽屉不是居中浮层：DSH 的骨架就是右侧 sidebar，抽屉同侧滑出与之一致，
			 * 且不遮挡正文；居中浮层会盖住聊天内容，还要额外处理居中与尺寸自适应。
			 *
			 * 排版红线（用户实测痛点）：「文字太长超出屏幕」。
			 *   - 文件名必须 ellipsis，且配合 min-width: 0 才生效（flex 子项默认 min-width:auto 会撑破）；
			 *   - description **不进行内**，只放 title 属性 hover 查看；
			 *   - 行高与列宽固定，不随文件名长短抖动。
			 */
			.dsa-dl-button {
				display: inline-flex; align-items: center; gap: 6px;
				padding: 4px 10px; border-radius: 8px; cursor: pointer;
				border: 1px solid var(--dsw-alias-border-subtle, rgba(128,128,128,.22));
				background: var(--dsw-alias-bg-base, rgba(128,128,128,.04));
				color: var(--dsw-alias-text-secondary, #6b7280);
				font-size: 12px; line-height: 1.4; font-family: inherit;
				white-space: nowrap;
			}
			.dsa-dl-button:hover {
				background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.10));
				color: var(--dsw-alias-text-primary, inherit);
			}
			.dsa-dl-button-icon { flex: 0 0 auto; width: 14px; height: 14px; opacity: .8; }
			.dsa-dl-button-count { font-weight: 600; opacity: .8; }

			/* 遮罩：铺满视口，**半透明**，点击关闭。
			 *
			 * ⚠️ v1.1.1 修复：这里原先用的是 --dsw-alias-bg-overlay，那是
			 *   **弹层/浮层自身的背景色**（不透明表面色，浅色主题下接近白色），
			 *   拿它当遮罩 ⇒ 抽屉一打开整页被不透明白色盖住（用户实测反馈：
			 *   「交付物文件抽屉打开后为什么背景变成白色了，不是透明」）。
			 *
			 * 正确变量是 --dsw-alias-bg-mask-1（官方 ui-theme design-platform.css:173）：
			 *   浅色主题 rgba(0, 0, 0, 0.24)；深色主题 rgba(0, 0, 0, 0.5)。
			 *   两者都是黑色半透明，深浅色下都不会出现纯白/纯黑。
			 * 兜底值与浅色主题一致；深色下若变量缺失会略淡，但仍是半透明黑，可接受。
			 */
			.dsa-dl-mask {
				position: fixed; inset: 0; z-index: 1200;
				background: var(--dsw-alias-bg-mask-1, rgba(0,0,0,.24));
				backdrop-filter: blur(2px);
				display: flex; align-items: flex-end; justify-content: center;
			}
			/* 右侧抽屉：高度占满，宽度自适应但设上限；列表内部滚动，抽屉本身不超出视口。
			 *
			 * 背景必须**不透明**（否则会透出下面的聊天内容）。
			 * 用 --dsw-alias-bg-layer-1（层表面色：浅色近白、深色近黑），
			 * 与官方 design-platform.css:170/270 的定义一致；
			 * 不用 bg-mask-*（那是遮罩用的半透明黑）。
			 */
			.dsa-dl-drawer {
				display: flex; flex-direction: column;
				width: calc(100% - 16px); max-width: 560px;
				/* v0.3.1：height:100% 在移动端会被浏览器工具栏挤到视口外（底部内容够不着）。
				 * dvh = 动态视口高度（工具栏收起/展开时同步变化），比 vh 准。
				 * 两行都留：不支持 dvh 的老 WebView（<108）会忽略后一行，仍用 100vh 兜底。
				 * 需真机确认：旧版 Android WebView / iOS Safari 的工具栏切换是否仍漏底部。 */
				height: 60%; max-height: 60vh; max-height: 60dvh; min-height: 240px;
				background: var(--dsw-alias-bg-layer-1, rgba(24,24,24,.98));
				border: 1px solid var(--dsw-alias-border-subtle, rgba(128,128,128,.22)); border-bottom: none; border-radius: 16px 16px 0 0;
				box-shadow: 0 -8px 24px rgba(0,0,0,.22);
				font-size: 13px;
				color: var(--dsw-alias-text-primary, inherit);
			}
			.dsa-dl-grabber {
				flex: 0 0 auto; display: flex; justify-content: center;
				padding: 8px 0 4px;
			}
			.dsa-dl-grabber-bar {
				display: block; width: 36px; height: 4px; border-radius: 2px;
				background: var(--dsw-alias-border-l2, rgba(128,128,128,.5));
				opacity: .55;
			}
			.dsa-dl-drawer-head {
				display: flex; align-items: center; gap: 8px;
				flex: 0 0 auto;
				padding: 14px 16px;
				border-bottom: 1px solid var(--dsw-alias-border-subtle, rgba(128,128,128,.18));
				font-weight: 600; font-size: 13px;
			}
			.dsa-dl-drawer-count { font-weight: 500; opacity: .7; }
			.dsa-dl-close {
				margin-left: auto; flex: 0 0 auto;
				width: 26px; height: 26px; padding: 0;
				border-radius: 6px; cursor: pointer;
				border: none; background: transparent;
				color: var(--dsw-alias-text-secondary, #6b7280);
				font-size: 14px; line-height: 1; font-family: inherit;
			}
			.dsa-dl-close:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.12)); }
			/* 列表内部滚动：文件多时滚这里，抽屉本身不动 */
			.dsa-dl-list {
				flex: 1 1 auto; min-height: 0;
				overflow-y: auto;
				padding: 8px;
				display: flex; flex-direction: column; gap: 2px;
			}
			.dsa-dl-row {
				display: flex; align-items: center; gap: 10px;
				padding: 8px 10px; border-radius: 8px;
				/* 行宽固定：文件名再长也不改变行高/行宽 */
				min-width: 0;
			}
			.dsa-dl-row:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.10)); }
			/* 关键三行：flex:1 + min-width:0 + ellipsis —— 少任何一条长文件名就会撑破容器 */
			.dsa-dl-name {
				flex: 1 1 auto; min-width: 0;
				font-weight: 500;
				overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
			}
			.dsa-dl-size {
				flex: 0 0 auto;
				font-size: 11px; opacity: .6;
				font-variant-numeric: tabular-nums;
			}
			.dsa-dl-skipped {
				flex: 0 0 auto;
				font-size: 11px; opacity: .55;
				padding: 6px 16px 12px;
			}

			/* ---- v1.5.0 聊天流内「直链下载」卡片 ----
			 *
			 * 用户原话：「你不能做一个卡片然后卡片点击就是直接的下载地址吗」。
			 * 痛点：官方交付物卡片在手机 WebView 里点了没反应，用户拿不到文件。
			 *
			 * 命名用 dsa-dlc-*（c = card），与抽屉的 dsa-dl-* **分开**：
			 * 两套 DOM 可能同时出现在一屏里（抽屉 + turn 卡片），共用类名会让
			 * 「抽屉里调样式把卡片带歪」这种耦合悄悄发生。
			 *
			 * 排版红线沿用 v1.1.1 的教训（用户实测「文字太长超出屏幕」）：
			 *   · 容器 min-width:0 + 文件名 flex:1 1 auto + ellipsis，三条缺一不可；
			 *   · **不显示 description** —— 它可能上百字，任何平铺形态都会被撑破；
			 *   · 整卡可点 → 让点击区覆盖全卡（a 是 flex 容器，不是行内链接）。
			 */
			/* v0.3.1 手机端加固：显式 width:100% + box-sizing:border-box。
			 * 为什么：flex 列容器在窄屏下若没有显式宽度，卡片内的 a.dsa-dlc（block 级 flex）
			 * 会按内容撑宽，长文件名 + 图标 + 「点击下载」在 360dp 屏上曾出现过横向溢出（需真机确认）。 */
			.dsa-dlc-list { display: flex; flex-direction: column; gap: 6px; margin: 6px 0; width: 100%; max-width: 100%; box-sizing: border-box; }
			.dsa-dlc {
				display: flex; align-items: center; gap: 10px;
				box-sizing: border-box; min-width: 0; max-width: 100%;
				padding: 9px 12px; border-radius: 10px;
				border: 1px solid var(--dsw-alias-border-subtle, rgba(128,128,128,.22));
				background: var(--dsw-alias-bg-base, rgba(128,128,128,.04));
				color: inherit; text-decoration: none;
				font-family: inherit; font-size: 13px; line-height: 1.35;
				cursor: pointer;
				transition: background-color 120ms ease, border-color 120ms ease;
			}
			.dsa-dlc:hover {
				background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.10));
				border-color: var(--dsw-alias-border-l2, rgba(128,128,128,.34));
			}
			.dsa-dlc:focus-visible {
				outline: none;
				box-shadow: inset 0 0 0 2px var(--dsw-alias-brand-primary, #3b82f6);
			}
			.dsa-dlc-icon { flex: 0 0 auto; width: 16px; height: 16px; opacity: .75; }
			/* 关键三行：flex:1 + min-width:0 + ellipsis —— 长文件名不撑破聊天区 */
			.dsa-dlc-main { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
			/* ellipsis 三件套已在（overflow/text-overflow/white-space），v0.3.1 补 width:100%：
			 * span 是 flex column 的子项，缺宽度时在部分 WebView 版本里 ellipsis 不生效。 */
			.dsa-dlc-name {
				min-width: 0; width: 100%; font-weight: 500;
				overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
			}
			.dsa-dlc-meta {
				font-size: 11px; opacity: .62; white-space: nowrap;
				overflow: hidden; text-overflow: ellipsis;
			}
			.dsa-dlc-action { flex: 0 0 auto; font-size: 11px; opacity: .55; white-space: nowrap; }

			/* ---- v0.3.1 窄屏（手机）加固 ----
			 * 用户反馈「交付物文件在手机端适配有问题」，但未给出具体现象，
			 * 因此这里只做**保守放大**：不改变桌面端任何表现，只让窄屏更不容易出错。
			 * 断点取 480px：覆盖绝大多数竖屏手机（CSS px，非物理像素）。
			 * ⚠️ 以下每条的具体阈值均**需真机确认**，不要当成已验证结论。
			 */
			@media (max-width: 480px) {
				/* 抽屉全宽：92vw 在手机上会留一道 8vw 的缝，遮罩边缘露出聊天内容，
				 * 视觉上像「抽屉没贴合屏幕」；全宽后也顺手把可用宽度都留给文件名。 */
				.dsa-dl-drawer { width: 100%; max-width: 100%; border-radius: 16px 16px 0 0; }
				/* 抽屉标题栏/列表内边距统一收缩，把宽度让给内容。 */
				.dsa-dl-drawer-head { padding: 12px 12px; }
				.dsa-dl-list { padding: 6px; }
				.dsa-dl-row { padding: 10px 8px; gap: 8px; }
				/* 关闭按钮 26px 太小，手指点不中：抬到 32px（仍不抢视觉重心）。 */
				.dsa-dl-close { width: 32px; height: 32px; }
				/* 聊天流内卡片：padding 9px 时整卡约 37px，低于 44dp 触摸目标下限，
				 * 窄屏加大到 11px（≈41px）+ 字号不变，兼顾密度与可点性。 */
				.dsa-dlc { padding: 11px 10px; gap: 8px; }
				.dsa-dlc-action { font-size: 10px; }
			}
				`;

		const cssTag = 'dsh-server-auth/client.css';
		if (typeof document !== 'undefined' && !document.querySelector('style[data-plugin-css="' + cssTag + '"]')) {
			const tag = document.createElement('style');
			tag.dataset.plugin = 'dsh-server-auth';
			tag.dataset.pluginCss = cssTag;
			tag.textContent = css;
			document.head.appendChild(tag);
		}

		// ============================================================================
		// 通用 API 调用工具函数
		// ============================================================================
		async function fetchAdminApi(method, path, body) {
			const res = await fetch(path, {
				method: method,
				headers: body ? { 'content-type': 'application/json' } : {},
				body: body ? JSON.stringify(body) : undefined,
			});
			const data = await res.json().catch(() => ({}));
			if (res.status === 401) {
				const err = new Error('当前未登录或非管理员账号，无法查看用户列表');
				err.isAuth = true;
				throw err;
			}
			if (!res.ok) {
				throw new Error(data.error || '请求失败 (' + res.status + ')');
			}
			return data;
		}

		// ============================================================================
		// React 用户管理 Section 核心组件
		// ============================================================================
		function UserManagementSection() {
			const [users, setUsers] = useState([]);
			const [loading, setLoading] = useState(true);
			const [error, setError] = useState(null);
			const [notice, setNotice] = useState(null);

			// 新增用户表单状态
			const [newUsername, setNewUsername] = useState('');
			const [newPassword, setNewPassword] = useState('');
			const [newRole, setNewRole] = useState('user');
			const [submitting, setSubmitting] = useState(false);

			const showNotice = (msg, isErr = false) => {
				setNotice({ text: msg, isErr: isErr });
				setTimeout(() => setNotice(null), 4000);
			};

			const loadUsers = useCallback(async () => {
				try {
					setLoading(true);
					setError(null);
					const data = await fetchAdminApi('GET', '/admin/server-auth/users');
					setUsers(data.users || []);
				} catch (err) {
					setError(err.message);
				} finally {
					setLoading(false);
				}
			}, []);

			useEffect(() => {
				loadUsers();
			}, [loadUsers]);

			const handleAddUser = async (ev) => {
				ev.preventDefault();
				if (!newUsername.trim() || !newPassword) {
					showNotice('用户名和初始密码均为必填项', true);
					return;
				}
				try {
					setSubmitting(true);
					await fetchAdminApi('POST', '/admin/server-auth/users/add', {
						username: newUsername.trim(),
						password: newPassword,
						role: newRole,
					});
					setNewUsername('');
					setNewPassword('');
					showNotice('成功创建用户「' + newUsername.trim() + '」');
					await loadUsers();
				} catch (err) {
					showNotice(err.message, true);
				} finally {
					setSubmitting(false);
				}
			};

			const handleToggle = async (username) => {
				try {
					const res = await fetchAdminApi('POST', '/admin/server-auth/users/toggle', { username: username });
					showNotice('用户「' + username + '」已' + (res.enabled ? '启用' : '禁用'));
					await loadUsers();
				} catch (err) {
					showNotice(err.message, true);
				}
			};

			const handleChangePassword = async (username) => {
				const pw = window.prompt('请输入用户「' + username + '」的新密码:');
				if (pw === null || !pw.trim()) return;
				try {
					await fetchAdminApi('POST', '/admin/server-auth/users/password', {
						username: username,
						password: pw.trim(),
					});
					showNotice('用户「' + username + '」密码修改成功');
				} catch (err) {
					showNotice(err.message, true);
				}
			};

			const handleDelete = async (username) => {
				if (!window.confirm('确定要删除用户「' + username + '」吗？此操作不可恢复。')) return;
				try {
					await fetchAdminApi('POST', '/admin/server-auth/users/remove', { username: username });
					showNotice('用户「' + username + '」已删除');
					await loadUsers();
				} catch (err) {
					showNotice(err.message, true);
				}
			};

			// 非管理员或未认证状态处理
			if (error) {
				return e('div', { className: 'dsa-section-root' },
					e('div', { className: 'dsa-card' },
						e('h3', { className: 'dsa-title' }, '账号与权限管理'),
						e('div', { className: 'dsa-msg dsa-msg-err' }, error),
						e('div', { style: { marginTop: '12px' } },
							e('a', {
								href: '/login',
								className: 'dsa-btn dsa-btn-primary dsa-btn-sm',
								style: { textDecoration: 'none', display: 'inline-flex' },
							}, '前往重新登录')
						)
					)
				);
			}

			return e('div', { className: 'dsa-section-root' },
				// 卡片一：新增用户
				e('div', { className: 'dsa-card' },
					e('h3', { className: 'dsa-title' }, '新增账号'),
					e('p', { className: 'dsa-desc' }, '创建新的团队成员或管理员账号。所有账号共用同一个全局工作空间。'),
					e('form', { className: 'dsa-form-grid', onSubmit: handleAddUser },
						e('input', {
							className: 'dsa-input',
							placeholder: '用户名',
							value: newUsername,
							onChange: (e) => setNewUsername(e.target.value),
							autoComplete: 'off',
						}),
						e('input', {
							className: 'dsa-input',
							type: 'password',
							placeholder: '初始密码',
							value: newPassword,
							onChange: (e) => setNewPassword(e.target.value),
						}),
						e('select', {
							className: 'dsa-select',
							value: newRole,
							onChange: (e) => setNewRole(e.target.value),
						},
							e('option', { value: 'user' }, '普通用户 (User)'),
							e('option', { value: 'admin' }, '管理员 (Admin)')
						),
						e('button', {
							type: 'submit',
							className: 'dsa-btn dsa-btn-primary',
							disabled: submitting,
						}, submitting ? '正在创建...' : '＋ 添加用户')
					),
					notice && e('div', { className: 'dsa-msg ' + (notice.isErr ? 'dsa-msg-err' : 'dsa-msg-ok') }, notice.text)
				),

				// 卡片二：用户列表
				e('div', { className: 'dsa-card' },
					e('h3', { className: 'dsa-title' }, '用户名单 (' + users.length + ')'),
					e('p', { className: 'dsa-desc' }, '管理现有账号的状态与密码，修改即时生效并持久化写入。'),
					loading
						? e('div', { style: { padding: '20px', textAlign: 'center', color: '#6b7280' } }, '正在加载用户数据...')
						: e('div', { className: 'dsa-table-wrap' },
							e('table', { className: 'dsa-table' },
								e('thead', null,
									e('tr', null,
										e('th', null, '用户名'),
										e('th', null, '角色'),
										e('th', null, '状态'),
										e('th', null, '创建时间'),
										e('th', { style: { textAlign: 'right' } }, '操作')
									)
								),
								e('tbody', null,
									users.map((u) => e('tr', { key: u.id || u.username },
										e('td', { style: { fontWeight: 500 } }, u.username),
										e('td', null,
											e('span', {
												className: 'dsa-badge ' + (u.role === 'admin' ? 'dsa-badge-admin' : 'dsa-badge-user')
											}, u.role === 'admin' ? '管理员' : '普通用户')
										),
										e('td', null,
											e('span', {
												className: 'dsa-badge ' + (u.enabled ? 'dsa-badge-enabled' : 'dsa-badge-disabled')
											}, u.enabled ? '已启用' : '已禁用')
										),
										e('td', { style: { color: 'var(--dsw-text-sub, #6b7280)', fontSize: '12px' } },
											u.createdAt ? new Date(u.createdAt).toLocaleString('zh-CN', { hour12: false }) : '-'
										),
										e('td', { style: { textAlign: 'right', display: 'flex', justifyContent: 'flex-end', gap: '6px' } },
											e('button', {
												type: 'button',
												className: 'dsa-btn dsa-btn-sm dsa-btn-outline',
												onClick: () => handleChangePassword(u.username),
											}, '改密'),
											e('button', {
												type: 'button',
												className: 'dsa-btn dsa-btn-sm ' + (u.enabled ? 'dsa-btn-danger' : 'dsa-btn-outline'),
												onClick: () => handleToggle(u.username),
											}, u.enabled ? '禁用' : '启用'),
											e('button', {
												type: 'button',
												className: 'dsa-btn dsa-btn-sm dsa-btn-danger',
												onClick: () => handleDelete(u.username),
											}, '删除')
										)
									))
								)
							)
						)
				)
			);
		}

		// ============================================================================
		// v0.10.0 交付物卡片「下载」按钮
		// ============================================================================
		//
		// 【依赖契约 —— 隐性依赖，升级 DSH 后按钮消失请先查这里】
		//
		// 本按钮挂在官方 slot 'deliverables.file.actions'（kind 'list' / scope 'session'），
		// 定义于 deepseek-harness/packages/client/ui-deliverables/src/client/file-actions.ts。
		// 官方在 Deliverables.tsx 调 renderSlot('deliverables.file.actions', { ... })，
		// 把渲染结果放进 PresentedFileCard 的 actions 区（文件卡片右侧）。
		//
		// owner 里**没有 sessionId**，只有 actionUrl。而本插件的后端 file-ticket 要
		// sessionId + seq + index 三个坐标，所以必须从 actionUrl 反解。
		//
		// actionUrl 的形态来自官方 presented.ts 的 presentedFileUrl()：
		//
		//     present/open?sessionId=<sid>&seq=<n>&index=<i>
		//
		//     pathname === '/present/open'（文档相对，不带前导斜杠）
		//     searchParams: sessionId / seq / index，均为十进制整数（seq, index）
		//
		// ⚠️ 这是对官方实现的**隐性依赖**：官方一旦改变这个 URL 的形态（换路径、
		//    换参数名、把坐标挪进 path 段），本按钮的解析会失败并**静默不渲染**。
		//    —— 静默是刻意设计：绝不因为本插件的解析逻辑把官方卡片渲染搞崩。
		//    排查顺序：① 打开浏览器控制台看 "[dsh-postapi-bridge] present action
		//    URL 形态不符预期" 的告警（仅首次出现时打一次，不刷屏）
		//    ② 对照上面的 URL 形态 ③ 若官方确实改了，只改 parsePresentedActionUrl。
		//
		// 用 new URL(actionUrl, location.origin) 解析，**不用字符串 split**：
		// URL 解析器会把 pathname 的 %XX 解码、把非法百分号编码判为抛错，
		// 这层规整正好是我们想要的「可疑输入一律拒绝」；手写 split 会漏掉
		// '?a=1#frag'、'%00'、重复参数等边界。

		/** 官方 import 的这个 slot 只可能出现在文档相对路径下（同源） */
		const PRESENTED_ACTION_PATH = '/present/open';
		/** seq/index 的上界：与后端 Number.isSafeInteger 口径一致，防止 1e400 之类进 NaN */
		const MAX_COORDINATE = Number.MAX_SAFE_INTEGER;

		/**
		 * 把 actionUrl 反解成后端 file-ticket 需要的坐标。
		 *
		 * 纯函数、无副作用、**绝不抛错**：任何不合规输入一律返回 null，
		 * 调用方据此「不渲染按钮」（静默降级）。
		 *
		 * 校验项（缺一不可，宁可少一个按钮也不要发一个必错的请求）：
		 *   ① actionUrl 是非空字符串
		 *   ② 能按 origin 解析成同源 URL（跨来源/非法协议直接拒）
		 *   ③ pathname 是 /present/open（官方形态；以后改了就是这里命中）
		 *   ④ sessionId 非空
		 *   ⑤ seq / index 是 ≥ 0 的十进制安全整数（拒绝 '1.5' / '-1' / '0x10' / '1e3' / ''）
		 *
		 * @param {unknown} actionUrl 官方 owner 传下来的文档相对 action 路由
		 * @param {string} [origin] 解析基准；缺省取 location.origin（测试时可注入）
		 * @returns {{ sessionId: string, seq: number, index: number } | null}
		 */
		function parsePresentedActionUrl(actionUrl, origin) {
			try {
				if (typeof actionUrl !== 'string' || actionUrl.length === 0) return null;
				let base;
				if (typeof origin === 'string' && origin.length > 0) {
					base = origin;
				} else if (typeof location !== 'undefined' && location && typeof location.origin === 'string') {
					base = location.origin;
				} else {
					return null; // 非浏览器环境且没注入 origin：无从解析
				}
				const url = new URL(actionUrl, base);
				// 只认同源：actionUrl 本应相对文档，绝对外部 URL 一律当异常
				if (url.origin !== new URL(base).origin) return null;
				if (url.pathname !== PRESENTED_ACTION_PATH) return null;

				const sessionId = url.searchParams.get('sessionId');
				if (typeof sessionId !== 'string' || sessionId.length === 0) return null;

				// 严格十进制：'12abc'、' 12'、'1e3'、'0x10'、'+12' 全部不通过
				const parseIntStrict = (raw) => {
					if (typeof raw !== 'string' || !/^[0-9]+$/.test(raw)) return null;
					const n = Number(raw);
					if (!Number.isSafeInteger(n) || n < 0 || n > MAX_COORDINATE) return null;
					return n;
				};
				const seq = parseIntStrict(url.searchParams.get('seq'));
				if (seq === null) return null;
				const index = parseIntStrict(url.searchParams.get('index'));
				if (index === null) return null;

				return { sessionId: sessionId, seq: seq, index: index };
			} catch (err) {
				// 非法的百分号编码、非法 base、越界等 → 一律 null
				return null;
			}
		}

		/**
		 * 解析失败时打一次控制台告警（进程内只打一次）。
		 *
		 * 存在的意义：按钮「静默不显示」是有意设计，但**无声消失**会让运维
		 * 在 DSH 升级后无从下手。这条告警把「官方 actionUrl 形态变了」这个
		 * 最可能的原因直接说清楚，并带上实际收到的值。
		 * 只告警不改行为 —— 卡片仍然照常渲染，只是没有本插件的下载按钮。
		 */
		let parseFailureWarned = false;
		function warnParseFailureOnce(actionUrl) {
			if (parseFailureWarned) return;
			parseFailureWarned = true;
			// v0.11.1：把「解析失败」打成带固定前缀的一行，便于在控制台按前缀过滤。
			// **这是 B 情况的主因线索**：官方 actionUrl 形态若有变化（升级后最常见），
			// 或者 owner 根本没传 actionUrl，按钮就会静默隐藏。把原值原样打出来，
			// 才能区分「没传（undefined）」和「传了但形态不对」。
			dlLog('warn', 'skip: cannot parse actionUrl', String(actionUrl));
			try {
				console.warn(
					'[dsh-postapi-bridge] present action URL 形态不符预期，下载按钮已静默隐藏。'
					+ '预期形如 "present/open?sessionId=<sid>&seq=<n>&index=<i>"（官方 '
					+ 'presented.ts presentedFileUrl()）。实际收到: ' + String(actionUrl),
				);
			} catch (err) {}
		}

		/**
		 * 把 HTTP 状态码翻译成卡片上的 inline 文案。
		 * 401/403：未登录或会话失效（官方 fetch 包装会尝试跳登录页，这里只做提示）；
		 * 410：票据过期（后端在下载阶段才回 410，签发阶段不会）；
		 * 503：宿主未装配 sessionQuery / 票据库不可写 / 无签名密钥 —— 都是「服务不可用」；
		 * 413：超过 downloadMaxMB；404：present 记录或文件已不在。
		 * 其余状态一律落到「下载失败」，不把原始 error 文本怼给用户。
		 */
		function downloadErrorMessage(status) {
			if (status === 401 || status === 403) return '请先登录';
			if (status === 410) return '链接已过期，请重新打开';
			if (status === 503) return '下载服务不可用';
			if (status === 413) return '文件超出下载上限';
			return '下载失败';
		}

		/** 失败提示自动回到「下载」的次数上限内的停留时长（ms）：够看清，不长期占位 */
		const DOWNLOAD_ERROR_HOLD_MS = 4000;

		/**
		 * 交付物文件卡片上的「下载」按钮。
		 *
		 * props 由官方 owner 提供（见上方依赖契约）：
		 *   - actionUrl：从它反解 sessionId/seq/index
		 *   - available：宿主桌面是否可用 —— 与下载**无关**，故不参与判断
		 *     （官方 open/reveal 需要本机桌面；下载只是 HTTP GET，任何客户端都能下）
		 *   - pending：官方 open/reveal 在途 —— 与自身在途合并判断禁用
		 *   - onAction：官方原生的打开动作，本按钮**不调用**（下载不走它）
		 *
		 * 行为：
		 *   点击 → POST <apiPrefix>/file-ticket { sessionId, seq, index }
		 *        → 200 取 url → 交给隐藏 <a download> 的同源导航
		 *        → 非 200 → 按钮原地变错误态（inline，不 alert）
		 *
		 * 为什么用 <a download> 而不是 window.location.href = url：
		 *   ① 不打断当前会话页面（官方 SPA 状态、滚动位置、正在流的回复全保留）；
		 *   ② 不污染浏览器历史（location 赋值会在历史里留一条 /api/dsh/v1/file/<token>，
		 *      token 是 bearer 式凭据，留在历史/地址栏本身就是泄露面）；
		 *   ③ download 属性让浏览器走下载通道，而不是尝试就地打开，
		 *      文件名由后端的 Content-Disposition 决定（中文名按 RFC5987 编码）。
		 *   仍带 credentials（同源默认携带），后端 401/403 的二次校验照旧生效。
		 *
		 * 为什么不显示在 pending=open 时：与官方 open/reveal 的共享 pending 合并判断，
		 * 避免用户以为「点了没反应」而连点。
		 */
		function DownloadFileAction(props) {
			const actionUrl = props && props.actionUrl;
			const ownerPending = !!(props && props.pending);
			// v0.12.0：支持**直接给坐标**（面板自渲染时用），不再强制解析 actionUrl。
			// 判定顺序：显式坐标 > actionUrl 解析结果。
			// 这样同一组件既能服务官方卡片（给 actionUrl），也能服务自渲染面板（给坐标），
			// 逻辑（调 file-ticket → 同源校验 → <a download>）只有一份，不产生分叉。
			const explicit = props && props.coordinate;
			const hasExplicit = !!(explicit
				&& typeof explicit.sessionId === 'string' && explicit.sessionId.length > 0
				&& Number.isSafeInteger(explicit.seq)
				&& Number.isSafeInteger(explicit.index));
			const [state, setState] = useState('idle');   // idle | loading | error
			const [errorText, setErrorText] = useState('');
			// 在途标记用 ref：state 是异步生效的，连续两次快速点击之间的同步间隙里
			// state 仍是 'idle'，只靠 state 判断会漏掉一帧 → 重复请求。ref 同步生效。
			const inFlightRef = React.useRef(false);
			const holdTimerRef = React.useRef(null);

			const coordinate = React.useMemo(
				() => (hasExplicit
					? { sessionId: explicit.sessionId, seq: explicit.seq, index: explicit.index }
					: parsePresentedActionUrl(actionUrl)),
				[actionUrl, hasExplicit,
					hasExplicit ? explicit.sessionId : null,
					hasExplicit ? explicit.seq : null,
					hasExplicit ? explicit.index : null],
			);

			// v0.11.1 挂载痕迹：**这是区分 A/B 两种情况的唯一证据**。
			// 只要文件卡片渲染了本组件，就一定会出现这一行（每张卡片一条）。
			//   parsed=ok   → 按钮应该可见（若用户看不到，是 CSS/布局问题）
			//   parsed=fail → 按钮被静默隐藏（B 情况），紧随其后会打 skip 原因
			// 依赖 coordinate：actionUrl 变化（会话切换/卡片复用）时重新记一条。
			useEffect(() => {
				dlLog('info', 'action mounted url=' + String(actionUrl)
					+ ' parsed=' + (coordinate === null ? 'fail' : 'ok'));
			}, [actionUrl, coordinate]);

			// 卸载清理：错误文案的定时器必须收掉，否则会对已卸载组件 setState
			useEffect(() => () => {
				if (holdTimerRef.current !== null) clearTimeout(holdTimerRef.current);
			}, []);

			const handleClick = useCallback(() => {
				if (inFlightRef.current) return;              // 防抖：在途直接吞掉
				if (coordinate === null) return;              // 理论上不会走到（无坐标不渲染）
				inFlightRef.current = true;
				if (holdTimerRef.current !== null) {
					clearTimeout(holdTimerRef.current);
					holdTimerRef.current = null;
				}
				setState('loading');
				setErrorText('');

				const showError = (text) => {
					setErrorText(text);
					setState('error');
					holdTimerRef.current = setTimeout(() => {
						holdTimerRef.current = null;
						setState('idle');
						setErrorText('');
					}, DOWNLOAD_ERROR_HOLD_MS);
				};

				const base = (props && typeof props.apiPrefix === 'string' && props.apiPrefix.length > 0)
					? props.apiPrefix
					: '/api/dsh/v1';

				// v0.11.1：点击留痕。三个坐标都是非敏感值（会话 id/序号/下标），可安全打印；
				// 若这里没出现而用户说「点了没反应」，说明按钮被 disabled（在途/官方 pending）。
				dlLog('info', 'click -> POST ' + base + '/file-ticket '
					+ JSON.stringify({
						sessionId: coordinate.sessionId,
						seq: coordinate.seq,
						index: coordinate.index,
					}));

				fetch(base + '/file-ticket', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					credentials: 'same-origin',
					body: JSON.stringify({
						sessionId: coordinate.sessionId,
						seq: coordinate.seq,
						index: coordinate.index,
					}),
				})
					.then((res) => {
						if (!res.ok) {
							// v0.11.1：把状态码与响应体前 300 字符打出来。
							// 后端的错误体是 { ok:false, error:'...' }，足够定位是 503(无 sessionQuery)
							// 还是 401(未登录)/404(present 记录没了)/413(超限)。
							// 说明：错误体里不含 token，可安全打印。
							dlLog('warn', 'fail status=' + res.status);
							res.clone().text().then((body) => {
								dlLog('warn', 'fail body=' + String(body).slice(0, 300));
							}).catch(() => {});
							showError(downloadErrorMessage(res.status));
							return null;
						}
						return res.json().catch(() => null);
					})
					.then((data) => {
						if (data === null) return;              // 上面已按状态码给了错误文案
						const url = data && typeof data.url === 'string' ? data.url : '';
						// 后端只会返回 <apiPrefix>/file/<token> 这种文档相对路径。
						// 这里再卡一道：必须是同源文档相对路径，绝不把外部 URL 交给浏览器导航
						// （防止后端被篡改成开放重定向时把用户带走）。
						let sameOrigin = false;
						try {
							sameOrigin = new URL(url, location.origin).origin === location.origin;
						} catch (err) {
							sameOrigin = false;
						}
						if (!url || !sameOrigin) {
							showError('下载失败');
							return;
						}
						setState('idle');
						// v0.11.1：成功留痕。**绝不打印完整 url** —— 路径末段就是下载 token，
						// 属于 bearer 式凭据，进 console 等于泄露。这里只打脱敏后的 path。
						dlLog('info', 'issued, navigating to ' + maskDownloadUrl(url)
							+ ' filename=' + String((data && data.filename) || ''));
						triggerBrowserDownload(url, data && typeof data.filename === 'string' ? data.filename : '');
					})
					.catch(() => {
						// 网络层异常（断网、被扩展拦截）—— 与 5xx 同类，用兜底文案
						showError('下载失败');
					})
					.finally(() => {
						inFlightRef.current = false;
					});
			}, [coordinate, props && props.apiPrefix]);

			// 解析失败 → 静默不渲染（**设计，不是 bug**）。
			// 官方 slot 为空是合法状态，卡片照常显示 open/reveal。
			// 唯一副作用：控制台打一次告警，避免「按钮无声消失」变成无解谜题。
			// 用模块级 once 标志而非每次渲染都打 —— 文件卡片是多实例的，逐卡片刷屏没意义。
			if (coordinate === null) {
				// 仅在「没有显式坐标、靠 actionUrl 解析」失败时告警；
				// 面板自渲染场景不会走到这里（显式坐标一定合法，见 hasExplicit 判定）
				if (!hasExplicit) warnParseFailureOnce(actionUrl);
				return null;
			}

			const busy = state === 'loading' || ownerPending;
			const label = state === 'loading' ? '准备中…' : (state === 'error' ? errorText : '下载');

			return e('button', {
				type: 'button',
				className: 'dsa-dl',
				disabled: busy,
				'data-state': state,
				// title 提供失败文案的完整tooltip：极度窄的卡片上文字可能被省略号截断
				title: state === 'error' ? errorText : '下载该交付物',
				'aria-busy': state === 'loading' ? 'true' : undefined,
				'aria-label': state === 'error' ? '下载失败：' + errorText : undefined,
				onClick: handleClick,
			},
				state === 'loading' ? e('span', { className: 'dsa-dl-spin', 'aria-hidden': 'true' }) : null,
				e('span', null, label),
			);
		}

		/**
		 * 用隐藏 <a download> 触发下载。
		 *
		 * 单独抽出来的理由：① 便于单测/静态断言（不涉及 React）；② 把「为什么不直接
		 * 改 location」这个决策集中在一处文档化，而不是散在组件里。
		 * 失败（例如被浏览器策略拦截）静默吞掉 —— 下载是用户显式动作，
		 * 再弹一个错误也帮不上什么，下次点击会重试。
		 */
		function triggerBrowserDownload(url, filename) {
			try {
				const a = document.createElement('a');
				a.href = url;
				if (filename) a.download = filename;
				a.rel = 'noopener';
				a.style.display = 'none';
				document.body.appendChild(a);
				a.click();
				document.body.removeChild(a);
			} catch (err) {}
		}

		/** 人类可读的文件大小（1024 进制，保留一位）。 */
		function formatBytes(n) {
			if (typeof n !== 'number' || !isFinite(n) || n < 0) return '';
			if (n < 1024) return n + ' B';
			const units = ['KB', 'MB', 'GB'];
			let v = n / 1024, i = 0;
			while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
			return (Math.round(v * 10) / 10) + ' ' + units[i];
		}

		/**
		 * v1.1.0 交付物清单**共享加载器**（按 sessionId 缓存 + 短 TTL）。
		 *
		 * 为什么必须有缓存：turnTail 是**逐 turn** 渲染的，一个会话几十轮就会挂几十个组件实例。
		 * 若每个实例都各自 fetch 一次 /files，打开一个长会话会瞬间打出几十个请求 —— 既浪费
		 * 也会让后端审计被刷爆。这里用「同 sessionId 共享一个 Promise + 结果短 TTL」把并发与
		 * 重复请求都收敛成一次。
		 *
		 * 实现要点：
		 *   · 缓存的是**整个清单**（会话级），各 turn 组件拿到后自行按 turn 过滤；
		 *   · TTL 内的后续请求直接复用上次结果（不重新联网）；
		 *   · 并发调用共享同一个 in-flight Promise（不会重复发）；
		 *   · 失败**不缓存**（下次渲染会重试，避免一次网络抖动后整会话永久空白）。
		 */
		// ⚠️ v1.1.0：TTL 从 8s 缩到 3s。
		// 原因（用户实测发现的功能 bug）：新 present 的文件必须能自动出现，不需要刷新页面。
		// 8s 的 TTL 意味着「刚发完文件、3~8 秒内界面还是旧数据」，用户会以为没生效。
		// 3s 是「够覆盖同一批 turn 的并发渲染（毫秒级）」与「新文件尽快出现」的折中；
		// 真正的即时性靠下面的**事件驱动失效**与**轮询比对 maxTurn**，不靠 TTL 长短。
		const FILES_CACHE_TTL_MS = 3000;
		const filesCache = new Map();      // key -> { at:number, promise:Promise }

		/**
		 * 主动失效某个会话的缓存（v1.1.0）。
		 *
		 * 为什么需要：仅靠 TTL 过期是**被动**的 —— 用户发完文件后界面要等 TTL 到期才更新。
		 * 拿到「有新的 present 事件」的信号时，必须能主动把缓存打掉、立刻重拉。
		 * 目前两个调用点：① turnTail 组件发现本轮 turn 号大于缓存里的 maxTurn；
		 * ② 外部（如后续接入会话事件流）可调用。
		 */
		function invalidateFilesCache (sessionId) {
			if (!sessionId) { filesCache.clear(); return }
			for (const k of Array.from(filesCache.keys())) {
				if (k.endsWith('|' + String(sessionId))) filesCache.delete(k)
			}
		}

		function loadSessionFiles (base, sessionId) {
			const key = String(base || '') + '|' + String(sessionId || '');
			const now = Date.now();
			const hit = filesCache.get(key);
			if (hit && now - hit.at < FILES_CACHE_TTL_MS) {
				dlLog('info', 'files cache hit sessionId=' + String(sessionId));
				return hit.promise;
			}
			// 参数名必须是 sessionId：`sid` 是宿主网关保留名，任意值都会被拦成空白 400
			// （网关拿 sid 做自己的会话解析，不认识就直接拒，请求到不了本插件后端）。
			const url = base + '/files?sessionId=' + encodeURIComponent(sessionId);
			const promise = fetch(url, { credentials: 'same-origin' })
				.then((res) => {
					if (!res.ok) {
						// 失败时打出请求 URL —— 端点被劫持/路径打错这类问题只能靠「打到了哪个路径」定位
						// URL 只含 apiPrefix 与 sessionId，不含任何 token，可安全打印。
						dlLog('warn', 'files skip: http status=' + res.status + ' url=' + url);
						res.clone().text().then((b) => {
							dlLog('warn', 'files skip body=' + String(b).slice(0, 300));
						}).catch(() => {});
						return null;
					}
					return res.json().catch(() => null);
				})
				.then((data) => {
					if (data === null || !data || data.ok !== true) return { ok: false, files: [], skipped: 0, maxTurn: -1 };
					const list = Array.isArray(data.files) ? data.files : [];
					// maxTurn：这批文件里最大的 turn 号。轮询时用它判断「有没有新的 present 事件」。
					let maxTurn = -1;
					for (const f of list) { if (f && typeof f.turn === 'number' && f.turn > maxTurn) maxTurn = f.turn }
					dlLog('info', 'files fetched n=' + list.length + ' skipped=' + (data.skipped || 0) + ' maxTurn=' + maxTurn);
					return { ok: true, files: list, skipped: typeof data.skipped === 'number' ? data.skipped : 0, maxTurn };
				})
				.catch((err) => {
					dlLog('warn', 'files skip: network ' + String(err && err.message ? err.message : err));
					return { ok: false, files: [], skipped: 0, maxTurn: -1 };
				});
			filesCache.set(key, { at: now, promise });
			// 失败不缓存：等到这个 promise 落地后，若是失败结果就把缓存条目删掉，让下次渲染重试
			promise.then((r) => { if (!r.ok) filesCache.delete(key) }).catch(() => { filesCache.delete(key) });
			return promise;
		}

		/** 仅供测试：清空缓存 / 查看缓存大小 */
		function __resetFilesCache () { filesCache.clear() }

		// v1.5.0 聊天流内直链卡片（为什么用 <a href> 而不是 onClick+fetch）：
		//   ① 用户卡住的正是「点击 → 前端发请求 → 再导航」这条链（官方卡片在手机 WebView
		//      里那一步没走通，点了没反应）。再用 fetch 换地址等于重演同一个坑；
		//   ② <a href download> 由浏览器原生处理：不依赖 JS 跑通、不依赖 fetch、
		//      不依赖 WebView 的 XHR 实现 —— 有 cookie 时浏览器自己发 GET 并落盘；
		//   ③ 原生下载走系统下载管理器：手机上有进度、可断点续传（后端支持 Range）；
		//   ④ 同源 cookie 会随浏览器发起的下载请求天然携带，无需 credentials 之类手段；
		//   ⑤ 失败可见：401/403/410 时显示后端文案，而不是「点了没反应」。
		//   ⇒ 静态断言（test/dl-card-static.mjs）钉住：卡片必须是 a[href]，卡片区域不得出现
		//     onClick / fetch / triggerBrowserDownload。

		/**
		 * 判断 downloadUrl 是否可直接用于下载（与后端 isUsableDownloadUrl 同口径）。
		 * 前端**必须独立校验**：卡片一旦渲染出坏 href（空值/外部地址/截断的 token），
		 * 用户看到的就是「又一张点不动的卡片」，比不渲染更糟。形态不对 → 静默不渲染。
		 */
		function isUsableDownloadUrl (url) {
			if (typeof url !== 'string' || url.length === 0 || url.length > 4096) return false;
			if (url.charAt(0) !== '/') return false;          // 只接受文档相对路径
			if (url.slice(0, 2) === '//') return false;       // 协议相对 == 外部主机
			if (/[\s\u0000-\u001f]/.test(url)) return false;
			const at = url.lastIndexOf('/dl/');
			if (at === -1) return false;
			return /^[A-Za-z0-9_.-]+$/.test(url.slice(at + 4));
		}

		/**
		 * 取「属于本 turn」的可下载文件。
		 * 只按 turn 匹配：/files 是会话级清单，每个 turn 的卡片只该显示本轮产出的文件，
		 * 否则同一批文件会在几十个 turn 里重复出现（v1.1.0 的教训）。
		 * 缺 turn 的文件（老数据）不归任何 turn，避免误挂。
		 */
		function pickTurnDownloadFiles (files, turn) {
			if (!Array.isArray(files) || !Number.isSafeInteger(turn)) return [];
			return files.filter((f) => f && f.turn === turn && isUsableDownloadUrl(f.downloadUrl));
		}

		/**
		 * 聊天流内 turn 尾的直链下载卡片。
		 * 挂载点 conversation.chat.turnTail（与官方交付物卡片同一 slot，kind 'list'）。
		 * owner 带 turn: TurnLocation（ui-chat slots.ts TurnTailOwnerProps）与 sessionId；
		 * 两者任一缺失 → 不渲染（官方卡片不受影响：slot 为空是合法状态）。
		 * 数据来源复用 loadSessionFiles 缓存（共享 Promise + 短 TTL），几十个 turn 只发一次请求。
		 */
		function TurnDeliverablesLinks (props) {
			const turnRaw = props && props.turn && props.turn.turn;
			const turn = Number.isSafeInteger(turnRaw) ? turnRaw : null;
			const sessionId = props && props.sessionId;
			const base = (props && typeof props.apiPrefix === 'string' && props.apiPrefix.length > 0)
				? props.apiPrefix
				: '/api/dsh/v1';
			const [files, setFiles] = useState([]);
			const enabled = !!sessionId && turn !== null;

			useEffect(() => {
				if (!enabled) return;
				let alive = true;
				loadSessionFiles(base, sessionId).then((r) => {
					if (!alive || !r || !r.ok) return;
					setFiles(r.files);
				});
				return () => { alive = false };
			}, [enabled, base, sessionId]);

			if (!enabled) return null;
			const mine = pickTurnDownloadFiles(files, turn);
			if (mine.length === 0) return null;

			// 整张卡片是真实链接：href = 后端直链，download 让浏览器走下载通道。
			// 刻意不挂 onClick —— 点击由浏览器原生处理，JS 完全不参与。
			return e('div', { className: 'dsa-dlc-list', 'data-postapi-download-cards': String(turn) },
				mine.map((f) => e('a', {
					key: f.seq + ':' + f.index,
					className: 'dsa-dlc',
					href: f.downloadUrl,
					download: typeof f.name === 'string' && f.name.length > 0 ? f.name : true,
					rel: 'noopener',
					title: f.name,
					'data-postapi-download-card': f.seq + ':' + f.index,
				},
					e('svg', { className: 'dsa-dlc-icon', viewBox: '0 0 16 16', 'aria-hidden': 'true' },
						e('path', {
							fill: 'currentColor',
							d: 'M8 1.5a.75.75 0 0 1 .75.75v6.19l2.22-2.22a.75.75 0 1 1 1.06 1.06L8.53 10.8a.75.75 0 0 1-1.06 0L3.97 7.28a.75.75 0 1 1 1.06-1.06l2.22 2.22V2.25A.75.75 0 0 1 8 1.5z',
						}),
					),
					e('span', { className: 'dsa-dlc-main' },
						e('span', { className: 'dsa-dlc-name' }, f.name),
						// 不显示 description（用户反馈文字太长撑破布局）；只显示大小
						e('span', { className: 'dsa-dlc-meta' },
							(formatBytes(f.size) || '文件') + ' \u00b7 点击下载'),
					),
				)),
			);
		}



		/**
		 * v1.1.0 交付物入口 —— **紧凑按钮 + 右侧抽屉**。
		 *
		 * 交互形态经过两轮演进，最终确定为此：
		 *   ① 最初：会话顶部一个**平铺面板**（直出文件列表）
		 *   ② 中途：聊天流内 turn 尾平铺卡片
		 *   ③ **现在**：一个紧凑按钮，点开右侧抽屉看列表
		 *
		 * 为什么最终选「按钮 + 抽屉」：
		 *   用户原话「文字太长了，超出屏幕了，上面应该放按钮而不是一个框」。
		 *   文件 description 可能上百字（如 APK 那条），任何**平铺**形态都会撑破聊天区。
		 *   折叠成按钮后，聊天流只占一行高度，详情按需展开。
		 *
		 * 为什么抽屉（而不是居中浮层）：
		 *   DSH 本身以右侧 sidebar 为组织骨架，抽屉从右侧滑出与之一致，且不遮挡正文；
		 *   居中浮层会盖住聊天内容，还要处理居中与尺寸自适应，收益为零。
		 *
		 * 挂载点：conversation.session.header.actions（会话级，scope: 'session'）。
		 *   交付物是**会话级**信息，不是某一轮的信息 —— 放会话顶部才符合语义。
		 *   （中途试过逐 turn 的 turnTail，但那会按 turn 重复出现同一个会话级清单，已回退。）
		 *
		 * props：
		 *   - sessionId：必填；为空 → 不渲染
		 *   - apiPrefix：可选，缺省 /api/dsh/v1
		 */
		function DeliverablesLauncher(props) {
			const sessionId = props && props.sessionId;
			const base = (props && typeof props.apiPrefix === 'string' && props.apiPrefix.length > 0)
				? props.apiPrefix
				: '/api/dsh/v1';
			const [files, setFiles] = useState([]);
			const [skipped, setSkipped] = useState(0);
			const [open, setOpen] = useState(false);

			// ---- 取数 + 自动刷新（用户实测要求：发了新文件要能自动出现，不需刷新页面）----
			//
			// 为什么必须轮询：客户端拿不到会话事件流，只能靠「查一次、发现变了再更新」。
			// 为什么不会打爆后端：
			//   · 只在有 sessionId 时轮询，且 4s 一次；
			//   · 每次先走 loadSessionFiles，**命中缓存不联网**（多组件共享同一 sessionId 缓存）；
			//   · 抽屉打开时轮询间隔减半 —— 用户正在看，要及时；
			//   · 组件卸载即清 timer。
			useEffect(() => {
				if (!sessionId) return;
				let alive = true;
				const apply = (r) => {
					if (!alive) return;
					if (!r || !r.ok) { setFiles([0].slice(1)); return }
					setFiles(r.files);
					setSkipped(typeof r.skipped === 'number' ? r.skipped : 0);
				};
				loadSessionFiles(base, sessionId).then(apply);
				const tick = () => { if (!alive) return; loadSessionFiles(base, sessionId).then(apply) };
				const timer = setInterval(tick, open ? 2000 : 4000);
				return () => { alive = false; clearInterval(timer) };
			}, [sessionId, base, open]);

			// ---- 抽屉开关：ESC 关闭 + 锁滚动 ----
			useEffect(() => {
				if (!open) return;
				const onKey = (ev) => {
					if (ev && (ev.key === 'Escape' || ev.keyCode === 27)) setOpen(false)
				};
				const doc = typeof document !== 'undefined' ? document : null;
				if (doc && doc.addEventListener) doc.addEventListener('keydown', onKey);
				return () => {
					if (doc && doc.removeEventListener) doc.removeEventListener('keydown', onKey)
				};
			}, [open]);

			// N = 0（或没有会话）→ 整个按钮不渲染，不占位
			if (!sessionId || !files || files.length === 0) return null;

			const button = e('button', {
				type: 'button',
				className: 'dsa-dl-button',
				'data-postapi-deliverables-button': '',
				title: '查看本会话的交付文件',
				onClick: () => setOpen(true),
			},
				e('svg', { className: 'dsa-dl-button-icon', viewBox: '0 0 16 16', 'aria-hidden': 'true' },
					e('path', {
						fill: 'currentColor',
						d: 'M9 1H4a1.5 1.5 0 0 0-1.5 1.5v11A1.5 1.5 0 0 0 4 15h8a1.5 1.5 0 0 0 1.5-1.5V5.5L9 1zm0 1.5L12.5 6H9V2.5z',
					}),
				),
				e('span', { className: 'dsa-dl-button-text' }, '交付物文件'),
				e('span', { className: 'dsa-dl-button-count' }, '(' + files.length + ')'),
			);

			if (!open) return button;

			// ---- 抽屉 ----
			// 遮罩点击关闭；抽屉本体 stopPropagation，避免点内容也关
			return e('div', null,
				button,
				e('div', {
					className: 'dsa-dl-mask',
					'data-postapi-deliverables-mask': '',
					onClick: () => setOpen(false),
				},
					e('div', {
						className: 'dsa-dl-drawer',
						'data-postapi-deliverables-drawer': '',
						role: 'dialog',
						'aria-label': '交付物文件',
						onClick: (ev) => { if (ev && ev.stopPropagation) ev.stopPropagation() },
					},
						// 拖拽指示条：手机底部抽屉的通用 affordance（暗示可下拉关闭）。
						e('div', { className: 'dsa-dl-grabber', 'aria-hidden': 'true' },
							e('span', { className: 'dsa-dl-grabber-bar' }),
						),
						e('div', { className: 'dsa-dl-drawer-head' },
							e('span', { className: 'dsa-dl-drawer-title' }, '交付物文件'),
							e('span', { className: 'dsa-dl-drawer-count' }, '(' + files.length + ')'),
							e('button', {
								type: 'button',
								className: 'dsa-dl-close',
								'data-postapi-deliverables-close': '',
								'aria-label': '关闭',
								onClick: () => setOpen(false),
							}, '\u2715'),
						),
						e('div', { className: 'dsa-dl-list' },
							files.map((f) => e('div', {
								className: 'dsa-dl-row',
								key: f.seq + ':' + f.index,
								'data-postapi-presented-row': '',
								// description 可能上百字 —— 只放 title（hover 看全文），绝不铺在行内
								title: f.description || f.path || f.name,
							},
								e('span', { className: 'dsa-dl-name' }, f.name),
								e('span', { className: 'dsa-dl-size' }, formatBytes(f.size)),
								e(DownloadFileAction, {
									// 坐标直接来自 /files 的 seq/index —— 不依赖官方 actionUrl 解析
									coordinate: { sessionId, seq: f.seq, index: f.index },
									apiPrefix: base,
								}),
							)),
						),
						skipped > 0
							? e('div', { className: 'dsa-dl-skipped' }, '另有 ' + skipped + ' 项不可用（已删除/超限/越权）')
							: null,
					),
				),
			);
		}

		// 供测试直接 import 的纯函数（node 侧无 window，故同时挂到 exports 上）
		const __downloadButtonHelpers = { parsePresentedActionUrl, downloadErrorMessage, triggerBrowserDownload, formatBytes };
		// ============================================================================
		// v1.7.0 切换会话后自动收起左侧栏（仅窄屏）
		// ============================================================================
		//
		// 需求原话：「app 端左侧切换会话不方便，是否可以在用户切换会话后自动辅助触发一次
		//   左侧栏收起」。用户确认左侧是**点击图标展开的会话列表**（不是常驻窄条）。
		// 症状：手机上点开会话列表选了另一个会话，列表（浮层）仍盖在对话上，要再点一次
		//   图标才能看到内容 —— 每次切会话多一次点击。
		//
		// ---- 依据（都已在 DSH 源码里核对过，改版时要按这些位置复查）----
		//   ① 读「是否已收起」：`[data-sidebar-collapsed]` 属性存在即收起。
		//      来源 @deepseek-ai/dsh-client-ui-layout/src/client/AppFrame.tsx:286
		//        data-sidebar-collapsed={sidebarCollapsed || undefined}
		//      为什么只能读 DOM：ILayout 只暴露 toggleSidebar()，**没有 isSidebarCollapsed()**；
		//        layoutInfo（含 narrowExpanded / sidebar）所在的 zustand store 是 root 私有的
		//        （ui-layout/src/client/index.ts 的 apply 里 createLayoutStore() 只在闭包内），
		//        插件层读不到 —— 所以「查不到属性」必须能静默跳过，见下面 ④。
		//   ② 收起侧栏：ctx.get('layout').toggleSidebar()
		//      来源 ui-layout/src/client/service.ts:41（接口声明）、:89（实现，转发到 stores）
		//   ③ 会话切换信号：ctx.get('uiSession').adapter.current（ObservableSnapshot）
		//      来源 ui-session/src/client/index.ts:313-317（adapter.current）、
		//        :435-449（publishMain：main 绑定真正换了 owner 才 notify → 无关的 retain
		//        计数变化不会空触发）、:594-605（createBindingSource 的 getSnapshot/subscribe）
		//      getSnapshot() 的形状：{ key: sessionId | undefined, hooks, keyedHooks, props }
		//        （key 来自 :571 key: binding.sessionId；缺席时见 :590 key: undefined）
		//      **不存在** ctx.on('session/changed') 这类事件，也没有 URL 路由 —— 别再找。
		//   ④ 「当前在会话视图」判据：`[data-panel-conversation]` 存在。
		//      来源 AppFrame.tsx 的 ConversationMarker：conversationActive 时 setAttribute，
		//        否则 removeAttribute。面板切走（设置 / 插件市场等）时该属性消失。
		//   ⑤ 窄屏阈值 1024 与 DSH 自己的 SIDEBAR_AUTO_COLLAPSE 一致
		//      （ui-layout/src/client/columns.ts:23；AppFrame.tsx:178 用它判 narrow）。
		//
		// ---- 边界（每条都对应一个真实的误伤场景）----
		//   · **首次加载不收起**：用户没切会话，凭什么动他的侧栏。靠 lastSessionId === null 判。
		//   · **宽屏（≥1024）不动**：宽屏侧栏是常驻导航，收起只是凭空少了导航栏，反而烦人。
		//   · **已经收起就不动**：toggleSidebar 是**开关语义**，不是 collapse；不看状态就调，
		//     会把已收起的侧栏**展开**（正好与需求相反）。
		//   · **查不到 [data-sidebar-collapsed] 就跳过**：DSH 改版去掉 / 改名该属性时，
		//     我们不能猜侧栏状态 —— 猜错的代价是用户侧栏被乱展开。宁可什么都不做。
		//   · **服务缺失（layout / uiSession）就跳过**：插件不该假设别的插件一定装着。
		//   · **面板切换不误伤**：只有 [data-panel-conversation] 存在才动手。已知残留
		//     （如实记录）：从会话 A 点「设置」、再点回会话 A 时，uiSession 的 key 可能仍是
		//     A（publishMain 只换 owner 才 notify），我们据此判「没变」而跳过 —— **漏收起**，
		//     不会误收起。这是有意的取舍：漏一次只是多点一下，误收一次是抢走用户正在用的导航。

		/** 窄屏阈值：与 DSH 的 SIDEBAR_AUTO_COLLAPSE 保持一致（ui-layout/src/client/columns.ts:23）。 */
		var POSTAPI_AUTOCLOSE_BREAKPOINT = 1024;

		/** 开关解析结果（排障：控制台看 __postapiAutoCollapse.state）。 */
		var postapiAutoCollapseState = { enabled: true, source: 'default' };

		/**
		 * v1.7.1：**最近一次成功安装的控制器**（供诊断浮层读基线 / 最近判定）。
		 * 为什么放模块级而不是只靠返回值：浮层是 apply() 里独立调用的，
		 *   不持有 setupAutoCollapseSidebar 的返回值；而 window.__postapiAutoCollapse
		 *   可能是 { active:false } 的失败结果（此时也确实没有基线可看）。
		 */
		var postapiAutoCollapseHandle = null;

		/**
		 * v1.7.1：**最近一次判定的现场快照**（诊断浮层的数据源）。
		 *
		 * 字段：action / reason、at（时间戳）、prevSessionId / sessionId（本次比较的两个 id）。
		 * 安装失败时 reason 写失败原因（no-layout / no-uisession / disabled …），
		 *   这样浮层在「根本没装起来」时也能给出原因，而不是一片空白。
		 * **只写不读业务逻辑** —— 纯诊断，不影响任何判定。
		 */
		var postapiAutoCollapseLastDiag = { action: 'none', reason: 'none', at: 0, prevSessionId: null, sessionId: null };


		/**
		 * 解析「切换会话后自动收起左侧栏」。**默认开启**。
		 *
		 * 优先级（高→低）：
		 *   ① URL 参数 ?autocollapse=off / on —— 现场临时开关，刷新即生效
		 *   ② 默认 → 开启
		 *
		 * 为什么默认开启，而 clientlog 默认关闭：这一条是**一次性的交互糖**（一次 toggle，
		 *   无常驻开销、无网络请求），不是诊断采集器 —— 前者适合默认开。
		 * 为什么只给 URL、不给 localStorage：用户想永久关掉时把参数写进书签即可；少一个
		 *   持久化状态，就少一处「当初怎么关的想不起来」。
		 *
		 * 读取异常（伪造 location、被裁剪的环境）一律**按默认开启处理**：与 clientlog 的
		 *   fail-closed 相反 —— 这里失败不产生副作用风险（最坏多收一次，且仍受「已收起则
		 *   不 toggle」保护），不值得为它吞掉整个功能。
		 *
		 * @param {object} [env] { search } （可注入，便于测试）
		 * @returns {{ enabled: boolean, source: string }} source: 'url'|'default'
		 */
		function resolveAutoCollapseEnabled (env) {
			var e = env || {};
			try {
				var search = typeof e.search === 'string' ? e.search : null;
				if (search === null) {
					search = (typeof location !== 'undefined' && location && typeof location.search === 'string')
						? location.search
						: (typeof window !== 'undefined' && window && window.location && typeof window.location.search === 'string' ? window.location.search : '');
				}
				var m = /[?&]autocollapse=([^&]*)/i.exec(search || '');
				if (m) {
					var v = String(m[1] || '').toLowerCase();
					// 兼容 on/1/true/yes 与 off/0/false/no；其它值视为「未表态」→ 回落默认（开）
					if (v === 'off' || v === '0' || v === 'false' || v === 'no') return { enabled: false, source: 'url' };
					if (v === 'on' || v === '1' || v === 'true' || v === 'yes') return { enabled: true, source: 'url' };
				}
			} catch (eUrl) {}
			return { enabled: true, source: 'default' };
		}


		/**
		 * 核心决策 + 执行（**纯决策、依赖可注入**，便于脱离浏览器单测）。
		 *
		 * 抽出来的理由：apply() 里只留一行调用；所有边界判断都能被 node 直接测到，
		 *   不必为了测它去跑整个 client bundle。
		 *
		 * @param {object} o
		 * @param {string|undefined|null} o.prevSessionId 上一次的会话 id（null = 首次，尚未建立基线）
		 * @param {string|undefined|null} o.sessionId     本次的会话 id
		 * @param {number} o.innerWidth      视口宽度（px）
		 * @param {boolean} o.collapsed      侧栏**当前**是否已收起（由调用方读 DOM 得出）
		 * @param {boolean} o.inConversation 当前是否在会话视图（DOM 里有 data-panel-conversation）
		 * @param {Function} o.toggle        收起动作（真实现 = ctx.get('layout').toggleSidebar()）
		 * @returns {{ action: string, reason: string }} action: 'collapsed' | 'skip'
		 *
		 * v1.7.1：**reason 覆盖每一个分支**（含 v1.7.0 的 first-load / unchanged），
		 *   不再复用一套名字给两种情况 —— 现场诊断浮层（?sidebardiag=1）直接把它画到屏幕上，
		 *   名字含糊等于没诊断。
		 *
		 * reason 全表（按判定顺序）：
		 *   first-load        首次加载，尚无基线（不动作）
		 *   same-session      会话 id 没变（面板切换 / retain 抖动）
		 *   no-session        本次没有会话 id（切到全局面板等）
		 *   wide              视口 ≥ 1024，宽屏不碰侧栏（innerWidth 非数字也归这条）
		 *   already-collapsed 侧栏本来就收起（toggle 是开关，再调会展开）
		 *   not-conversation  不在会话视图
		 *   collapsed         **执行了收起**（唯一会调 toggleSidebar 的分支）
		 *   toggle-threw      toggle 自己抛错（已吞掉，不外抛）
		 */
		function evaluateAutoCollapse (o) {
			var opts = o || {};
			var prev = opts.prevSessionId;
			var next = opts.sessionId;
			// ① 首次加载：还没有基线，只记录不动作（用户没切会话，凭什么动他的侧栏）
			if (prev === null || prev === undefined) {
				return { action: 'skip', reason: 'first-load' };
			}
			// ② 会话没变：面板切换 / retain 抖动导致的重复通知，忽略
			//    （统一按字符串比较：undefined / null 都视为「没有会话」）
			var aId = String(prev);
			var bId = next === undefined || next === null ? '' : String(next);
			if (aId === bId) return { action: 'skip', reason: 'same-session' };
			// ③ 没有会话 id（例如从会话切到全局面板）：不是「切到另一个会话」，不动
			if (bId === '') return { action: 'skip', reason: 'no-session' };
			// ④ 宽屏不动：宽屏侧栏是常驻导航，收起反而烦人
			//    阈值 1024 与 DSH 的 SIDEBAR_AUTO_COLLAPSE 一致（columns.ts:23）
			//    innerWidth 非数字（伪造 window / 注入桩）同样归 wide：拿不到宽度就不猜
			if (typeof opts.innerWidth !== 'number' || !(opts.innerWidth < POSTAPI_AUTOCLOSE_BREAKPOINT)) {
				return { action: 'skip', reason: 'wide' };
			}
			// ⑤ 已经是收起状态：不动。toggleSidebar 是**开关**，再调一次会把它展开
			//    （顺序放在 inConversation 之前：这是更硬的安全条件）
			if (opts.collapsed !== false) return { action: 'skip', reason: 'already-collapsed' };
			// ⑥ v1.7.8：不再校验 inConversation。
			// 原检查靠 [data-panel-conversation] 判断在会话视图；真机诊断证伪：
			// conversation.session/tabs/scroll/composer-seat 全部存在（确实在会话页），
			// 而 [data-panel-conversation] 不存在 —— 该标记在移动端不可靠。
			// 误收可再点开；误不收才是当前症状。保留入参供诊断，不再据此拦截。
			// ⑦ 收。单独 try：toggle 抛错时不污染上面的决策结果，更不能冒泡进订阅回调
			try {
				if (typeof opts.toggle === 'function') opts.toggle();
				return { action: 'collapsed', reason: 'collapsed' };
			} catch (eToggle) {
				return { action: 'skip', reason: 'toggle-threw' };
			}
		}


		/**
		 * 把「切换会话后自动收起左侧栏」装到真实页面上（apply 里调用一次）。
		 * **调用方负责 try/catch**；内部控制流上也逐个兜错 —— 这是交互辅助能力，
		 * 绝不能影响插件其余部分（尤其不能白屏）。
		 *
		 * @param {object} ctx cordis 客户端上下文
		 * @param {object} [opts] { win, doc, search, log } 可注入，便于测试
		 * @returns {{ active: boolean, reason?: string, state?: object }}
		 */
		function setupAutoCollapseSidebar (ctx, opts) {
			var o = opts || {};
			var win = o.win || (typeof window !== 'undefined' ? window : undefined);
			var doc = o.doc || (typeof document !== 'undefined' ? document : undefined);
			var log = typeof o.log === 'function' ? o.log : function () {};
			if (!win || !doc) return { active: false, reason: 'no-dom' };

			// 逃生阀：?autocollapse=off 关闭（默认开）。关掉时**不订阅任何东西**。
			var flag = resolveAutoCollapseEnabled({ search: o.search });
			postapiAutoCollapseState = flag;
			if (!flag.enabled) {
				log('autocollapse: disabled by url');
				postapiAutoCollapseLastDiag = { action: 'off', reason: 'disabled', at: Date.now(), prevSessionId: null, sessionId: null };
				return { active: false, reason: 'disabled', state: flag };
			}

			// 服务探测一律走 ctx.get()：cordis 里直接读 ctx.xxx 上的未声明服务会 throw，
			// 而本插件的 inject 只有 ['slots']，layout / uiSession 都不在声明里。
			//
			// ⚠️ v1.7.5 的 bug（用户真机诊断数据证实）：安装时一次性取服务快照，
			//    拿不到就直接放弃（reason='no-layout'）。但插件加载顺序不保证 ——
			//    我们可能比 ui-layout / ui-session 先初始化，那一刻服务还没 provide。
			//    现场数据：innerWidth=440（正确）、侧栏确实展开、但 autocollapse=no-layout。
			//    ⇒ 改成惰性 getter：每次用时现取，加载顺序不再影响结果。
			function getLayout () {
				try {
					var l = ctx && typeof ctx.get === 'function' ? ctx.get('layout') : null;
					return (l && typeof l.toggleSidebar === 'function') ? l : null;
				} catch (eL) { return null; }
			}
			function getSessionSource () {
				try {
					var u = ctx && typeof ctx.get === 'function' ? ctx.get('uiSession') : null;
					var src = u && u.adapter && u.adapter.current;
					return (src && typeof src.getSnapshot === 'function' && typeof src.subscribe === 'function') ? src : null;
				} catch (eU) { return null; }
			}

			if (!getLayout()) log('autocollapse: layout not ready at install (will look up on each check)');
			var source = getSessionSource();
			if (!source) log('autocollapse: uiSession.adapter.current not ready at install');

			/**
			 * 读当前会话 id。快照形状见 ui-session/src/client/index.ts:571（key 字段）。
			 * 任何异常 → undefined（当作「没有会话」，被 evaluate 的 no-session 分支跳过）。
			 */
			function readSessionId () {
				try {
					var snap = source.getSnapshot();
					return snap && typeof snap === 'object' ? snap.key : undefined;
				} catch (eRead) { return undefined }
			}

			// null = 首次（尚未建立基线）。**必须在安装时同步取一次**：否则第一次通知时
			// prev 还是 null，会把「当时已经在 A、现在切到 B」也当成首次加载而漏收起。
			var lastSessionId = null;
			(function initBaseline () {
				try {
					var first = readSessionId();
					lastSessionId = first === undefined || first === null ? null : first;
				} catch (eInit) { lastSessionId = null }
			})();

			var disposed = false;
			function onChange () {
				if (disposed) return { action: 'skip', reason: 'disposed' };
				try {
					var nextId = readSessionId();
					// 侧栏状态**只从 DOM 读**（AppFrame.tsx:286）。查不到 = 状态未知 →
					// 直接跳过，绝不在未知状态下调 toggle（猜错会把用户刚收起的侧栏展开）
					var collapsedKnown = false;
					var collapsed = false;
					try {
						collapsed = doc.querySelector('[data-sidebar-collapsed]') !== null;
						collapsedKnown = true;
					} catch (eSel) { collapsedKnown = false }
					// 是否在会话视图：AppFrame 的 ConversationMarker 维护该属性
					var inConversation = false;
					try { inConversation = doc.querySelector('[data-panel-conversation]') !== null } catch (eSel2) { inConversation = false }

					if (!collapsedKnown) {
						// 查不到侧栏状态 → 静默跳过，且**不更新基线**（下次仍按「切换」判断）
						log('autocollapse: [data-sidebar-collapsed] not found, skip');
						postapiAutoCollapseLastDiag = {
							action: 'skip', reason: 'unknown-sidebar-state', at: Date.now(),
							prevSessionId: lastSessionId, sessionId: nextId === undefined ? null : nextId,
						};
						return { action: 'skip', reason: 'unknown-sidebar-state' };
					}
					var r = evaluateAutoCollapse({
						prevSessionId: lastSessionId,
						sessionId: nextId,
						innerWidth: typeof win.innerWidth === 'number' ? win.innerWidth : 0,
						collapsed: collapsed,
						inConversation: inConversation,
						// 每次现取（服务可能晚于本插件初始化）
						toggle: function () {
							var l = getLayout();
							if (l) l.toggleSidebar();
						},
					});
					// 基线永远前移（无论是否动作）：否则「本次没收起」会被后续无关通知
					// 反复当成新变化，用户可能在别的时刻被意外收起。
					// v1.7.1 诊断：先记「本次比较的旧基线」，再把基线前移
					var diagPrev = lastSessionId;
					lastSessionId = nextId === undefined || nextId === null ? null : nextId;
					if (r.action === 'collapsed') log('autocollapse: sidebar collapsed after session switch');
					postapiAutoCollapseLastDiag = {
						action: r.action, reason: r.reason, at: Date.now(),
						prevSessionId: diagPrev, sessionId: nextId === undefined ? null : nextId,
					};
					return r;
				} catch (e) {
					// 订阅回调里抛错会冒泡进 Observable 的通知循环（可能影响其它订阅者），
					// 所以这里必须自己吞掉；留一条 log 便于现场排障。
					log('autocollapse error: ' + String(e && e.message ? e.message : e));
					postapiAutoCollapseLastDiag = { action: 'skip', reason: 'error', at: Date.now(), prevSessionId: lastSessionId, sessionId: null };
					return { action: 'skip', reason: 'error' };
				}
			}

			var unsubscribe = null;
			// 订阅：若安装时 uiSession 还没就绪（source=null），这里跳过订阅，
			// 但下面会起一个短时轮询，等服务出现后自动补订（否则永远不工作）。
			try { if (source) unsubscribe = source.subscribe(onChange) } catch (eSub) {
				log('autocollapse: subscribe failed');
				postapiAutoCollapseLastDiag = { action: 'off', reason: 'subscribe-failed', at: Date.now(), prevSessionId: null, sessionId: null };
				return { active: false, reason: 'subscribe-failed', state: flag };
			}

			// 服务就绪轮询：安装时若 uiSession 还没出现（source=null），订阅没建立。
			// 起一个短时轮询（最多 20 次 × 500ms = 10 秒），服务一出现就补订并自停。
			// 为什么需要：插件加载顺序不受控，可能早于 ui-session / ui-layout。
			// 10 秒上限：避免服务真的不存在时永远轮询（那会变成常驻开销）。
			var serviceRetryTimer = null;
			var serviceRetryCount = 0;
			if (!source) {
				try {
					serviceRetryTimer = win.setInterval(function () {
						if (disposed) return;
						serviceRetryCount += 1;
						var src = getSessionSource();
						if (src) {
							try { unsubscribe = src.subscribe(onChange) } catch (eS) {}
							source = src;
							try { win.clearInterval(serviceRetryTimer) } catch (eC) {}
							serviceRetryTimer = null;
							log('autocollapse: uiSession ready after ' + serviceRetryCount + ' retries, subscribed');
							return;
						}
						if (serviceRetryCount >= 20) {
							try { win.clearInterval(serviceRetryTimer) } catch (eC2) {}
							serviceRetryTimer = null;
							log('autocollapse: uiSession never appeared after 20 retries, giving up');
						}
					}, 500);
				} catch (eRetry) { serviceRetryTimer = null; }
			}

			log('autocollapse: installed (breakpoint ' + POSTAPI_AUTOCLOSE_BREAKPOINT + 'px)');
			var installed = {
				active: true,
				state: flag,
				// 仅供测试 / 排障
				__trigger: onChange,
				__getLastSessionId: function () { return lastSessionId; },
				// v1.7.1：实时读当前会话 id（诊断浮层用）。**不改变基线**，纯读。
				__getSessionIdNow: function () { return readSessionId(); },
				dispose: function () {
					disposed = true;
					try { if (serviceRetryTimer !== null) win.clearInterval(serviceRetryTimer) } catch (eCR) {}
					serviceRetryTimer = null;
					try { if (typeof unsubscribe === 'function') unsubscribe() } catch (eUnsub) {}
				},
			};
			// v1.7.1：登记给诊断浮层（浮层不持有返回值）
			postapiAutoCollapseHandle = installed;
			return installed;
		}


		// ============================================================================
		// v1.7.1 侧栏自动收起的现场诊断浮层（?sidebardiag=1）
		// ============================================================================
		//
		// 为什么需要：v1.7.0 的判定逻辑在本地单测全绿，但用户真机上**无效**
		//   （华为 VDE-AL10 / Android 16 / WebView Chrome 114 / 视口 440px）。
		//   手机上没有 devtools，用户拿不到 console —— 只能靠眼睛看界面、截图反馈。
		//   所以把关键判据直接画在屏幕上。
		//
		// 为什么是「网页浮层」而不是右侧抽屉：右侧抽屉是 Android 原生 UI
		//   （activity_webview.xml），要往里塞得改安卓工程 —— 跨仓库、要重新打包安装。
		//   而 position:fixed 浮层只改本文件即可，是现场排障的最短路径。
		//
		// **只在 ?sidebardiag=1 时安装**：普通用户不该看到这些黑话。
		//   默认不装 = 零开销（连 setInterval 都没有）。
		//
		// ---- 浮层里每一行的含义（也是排查顺序）----
		//   innerWidth              window.innerWidth。判定用的就是这个值。
		//   DSH viewportWidth       DSH 自己算出来的视口宽（读不到就 unknown，不猜）。
		//                           **和 innerWidth 差得远 = 排版层与判定层认知不一致**。
		//   [data-sidebar-collapsed]  存在 = 侧栏已收起；不存在 = 展开（或属性被改版去掉）。
		//   [data-panel-conversation] 存在 = 在会话视图。
		//   autocollapse            active / no-layout / no-uisession / disabled / none
		//                           —— 安装结果。非 active 就说明功能压根没装上。
		//   lastSessionId / sessionId(now)  基线 vs 当前。**两者恒相等 = 订阅没触发过**。
		//   lastAction              最近一次判定的 action/reason（含安装失败原因）。

		/**
		 * 读 DSH 自己认知的视口宽度。读不到返回 'unknown'（**绝不猜**）。
		 *
		 * 已知来源（按可靠性排序）：
		 *   ① .frame 的 inline style.gridTemplateColumns —— 布局是「列宽 + 剩余」，
		 *      第一段就是这个面板的视口宽度。这是 DSH 实际用来排版的值，
		 *      和 window.innerWidth 不一致时，**问题通常在这里**。
		 *   ② 退一步：.frame 的 getBoundingClientRect().width。
		 * 两者都拿不到就 unknown —— 猜一个数比没有更糟（会误导排查方向）。
		 *
		 * @param {Document} doc
		 * @returns {string} 数字字符串或 'unknown'
		 */
		function readDshViewportWidth (doc) {
			try {
				if (!doc || typeof doc.querySelector !== 'function') return 'unknown';
				var frame = doc.querySelector('.frame');
				if (!frame) return 'unknown';
				// ① gridTemplateColumns：形如 "300px 0px 0px 1fr" / "26px 0px 0px 414px"
				var gtc = '';
				try {
					gtc = (frame.style && typeof frame.style.gridTemplateColumns === 'string') ? frame.style.gridTemplateColumns : '';
				} catch (eGtc) { gtc = ''; }
				if (!gtc) {
					try {
						var cs = typeof window !== 'undefined' && window.getComputedStyle ? window.getComputedStyle(frame) : null;
						gtc = cs && typeof cs.gridTemplateColumns === 'string' ? cs.gridTemplateColumns : '';
					} catch (eCs) { gtc = ''; }
				}
				var m = /^\s*([0-9]+(?:\.[0-9]+)?)px/.exec(String(gtc || ''));
				if (m) return m[1];
				// ② 兜底：元素实际宽度
				if (typeof frame.getBoundingClientRect === 'function') {
					var w = frame.getBoundingClientRect().width;
					if (typeof w === 'number' && w > 0) return String(Math.round(w));
				}
			} catch (eRead) {}
			return 'unknown';
		}

		/**
		 * 收集诊断快照（**纯读，不写任何业务状态**，单独导出便于单测）。
		 *
		 * @param {object} o { doc, win, handle, lastDiag, state }
		 * @returns {Array<[string, string]>} 有序的 [标签, 值] 对，浮层按顺序逐行画
		 */
		function collectSidebarDiag (o) {
			var opts = o || {};
			var doc = opts.doc;
			var win = opts.win;
			var handle = opts.handle || null;
			var diag = opts.lastDiag || { action: 'none', reason: 'none' };
			var flag = opts.state || { enabled: true, source: 'default' };
			var rows = [];

			var innerWidth = 'unknown';
			try {
				innerWidth = win && typeof win.innerWidth === 'number' ? String(win.innerWidth) : 'unknown';
			} catch (eIw) { innerWidth = 'unknown'; }
			rows.push(['innerWidth: ', innerWidth]);

			rows.push(['DSH viewportWidth: ', readDshViewportWidth(doc)]);

			/** 查一个选择器是否命中；查询本身抛错也要落到「不存在」以外的清楚文字。 */
			var has = function (sel) {
				try {
					if (!doc || typeof doc.querySelector !== 'function') return '查询失败(document 不可用)';
					return doc.querySelector(sel) ? '存在' : '不存在';
				} catch (eHas) { return '查询失败(' + String(eHas && eHas.message ? eHas.message : eHas) + ')'; }
			};
			rows.push(['[data-sidebar-collapsed]: ', has('[data-sidebar-collapsed]')]);
			rows.push(['[data-panel-conversation]: ', has('[data-panel-conversation]')]);

			// 安装结果：active 优先看 handle（成功安装才会被登记）
			var ac = 'none';
			if (handle && handle.active === true) ac = 'active';
			else if (flag && flag.enabled === false) ac = 'disabled';
			else if (diag && diag.action === 'off' && diag.reason) ac = diag.reason;
			rows.push(['autocollapse: ', ac]);

			var last = 'null';
			try {
				if (handle && typeof handle.__getLastSessionId === 'function') {
					var v = handle.__getLastSessionId();
					last = v === null || v === undefined ? 'null' : String(v);
				}
			} catch (eLast) { last = 'unknown'; }
			rows.push(['lastSessionId: ', last]);

			var now = 'null';
			try {
				if (handle && typeof handle.__getSessionIdNow === 'function') {
					var n = handle.__getSessionIdNow();
					now = n === null || n === undefined ? 'null' : String(n);
				}
			} catch (eNow) { now = 'unknown'; }
			rows.push(['sessionId(now): ', now]);

			rows.push(['lastAction: ', String(diag.action || 'none') + ' / ' + String(diag.reason || 'none')]);

			// ---- v1.7.7 追加观测项（排查 not-conversation 用）----
			// 目的：现场只知道「属性不存在」，但不知道为什么。补上判据的原始素材。

			// ① 完整判定参数（onChange 里存下来的快照）
			var full = 'none';
			try {
				if (diag && diag.detail) full = JSON.stringify(diag.detail);
			} catch (eFull) { full = 'stringify-failed'; }
			rows.push(['diagDetail: ', full]);

			// ② onChange 被调用了几次（区分「订阅没触发」和「触发了但判定失败」）
			rows.push(['onChangeCount: ', String(typeof diag.onChangeCount === 'number' ? diag.onChangeCount : 'unknown')]);

			// ③ 侧栏 & 会话视图的属性，再看一次但在不同选择器下（排除选择器写错）
			var frameEl = null;
			var frameClass = 'none';
			try {
				frameEl = doc.querySelector('[data-shell-overlay]');
				if (frameEl && frameEl.parentElement) frameClass = String(frameEl.parentElement.className || '').slice(0, 80);
			} catch (eFrame) { frameClass = 'err'; }
			rows.push(['frameClass: ', frameClass || 'empty']);

			// ④ 主面板：DSH 用 activePanelId === null 表示「在会话」。DOM 上只能间接看。
			//    这里列几个能区分面板的属性，供比对。
			var haseSess = 'unknown';
			try { haseSess = doc.querySelector('[data-slot="conversation.session"]') ? '存在' : '不存在'; } catch (e1) {}
			rows.push(['conversation.session: ', haseSess]);

			var hasTabs = 'unknown';
			try { hasTabs = doc.querySelector('[data-conversation-tabs]') ? '存在' : '不存在'; } catch (e2) {}
			rows.push(['conversation-tabs: ', hasTabs]);

			var hasScroll = 'unknown';
			try { hasScroll = doc.querySelector('[data-conversation-scroll]') ? '存在' : '不存在'; } catch (e3) {}
			rows.push(['conversation-scroll: ', hasScroll]);

			// ⑤ 输入框区：在会话页应该有 composer-seat
			var hasComposer = 'unknown';
			try { hasComposer = doc.querySelector('[data-composer-seat]') ? '存在' : '不存在'; } catch (e4) {}
			rows.push(['composer-seat: ', hasComposer]);

			return rows;
		}

		/** 值短的放一行，长的（会话 id）单独换行，避免 max-width 下挤成一团。 */
		function renderSidebarDiag (container, rows, e) {
			var doc = container.ownerDocument;
			// 用原生 DOM 而不是 React：浮层与 React 生命周期无关，越简单越不会坏
			while (container.firstChild) container.removeChild(container.firstChild);
			for (var i = 0; i < rows.length; i += 1) {
				var line = doc.createElement('div');
				var label = doc.createElement('span');
				label.style.opacity = '0.62';
				label.textContent = rows[i][0];
				var value = doc.createElement('span');
				value.textContent = rows[i][1];
				line.appendChild(label);
				line.appendChild(value);
				container.appendChild(line);
			}
		}

		/**
		 * 安装诊断浮层（**只在 ?sidebardiag=1 时调用**）。
		 *
		 * 只读：不碰 layout / uiSession / 任何 DOM 属性，只 querySelector 读状态 + 画一个
		 *   pointer-events:none 的浮层。所以即使浮层写坏了也不会影响自动收起本身。
		 *
		 * @param {object} ctx cordis 客户端上下文（保持签名一致；本函数不从中取服务）
		 * @param {object} [opts] { win, doc, search, log, handle, lastDiag, state, intervalMs }
		 * @returns {{ active: boolean, reason?: string, __refresh?: Function, dispose?: Function }}
		 */

			// ============================================================================
			// v1.7.4：诊断数据自动上报（每 2s 采集、每 30s 批量）
			// ============================================================================
			/**
			 * 诊断开关打开时，把侧栏相关状态定期上报到 /client-log。
			 *
			 * 为什么需要：用户在手机上无处看 console，浮层只能人眼看。
			 *   自动上报后，我们（服务端）能直接读到判定链路，不必让用户念数字。
			 *
			 * 为什么要攒批：/client-log 有频率限制（每 IP 每小时 20 次）。
			 *   每 2s 发一次会立刻打满。攒 15 条（30s）发一次，每小时 120 次仍会超。
			 *   ⇒ 实际节流由服务端判定，超限时静默丢弃（下个周期继续尝试）。
			 *
			 * @returns {{ push: Function, flushNow: Function, stop: Function } | null}
			 */
			function startSidebarDiagReporter (opts) {
				var o = opts || {};
				var win = o.win || (typeof window !== 'undefined' ? window : undefined);
				var doc = o.doc || (typeof document !== 'undefined' ? document : undefined);
				if (!win || !doc) return null;

				// 端点直接复用 CL_ENDPOINT（与 client-log 采集器同一个免鉴权入口）。
				// 不依赖 apply() 透传 apiPrefix —— 宿主不透传 config，拿不到。
				var endpoint = o.endpoint || CL_ENDPOINT;
				if (!endpoint) return null;

				var MAX_QUEUE = 300;          // 攒批上限（约 10 分钟的数据）
				var COLLECT_MS = 2000;        // 采集间隔
				var FLUSH_MS = 30000;         // 上报间隔

				var queue = [];
				var collectTimer = null;
				var flushTimer = null;
				var uploaded = 0;

				function sample () {
					try {
						var rows = collectSidebarDiag({
							doc: doc,
							win: win,
							handle: postapiAutoCollapseHandle,
							lastDiag: postapiAutoCollapseLastDiag,
							state: postapiAutoCollapseState,
						});
						// ⚠️ 服务端 /client-log 对每条 entry 做**白名单**过滤：
						//    只保留 t / level / kind / duration / msg / extra 六个字段。
						//    直接塞 innerWidth 之类的自定义 key 会被整条丢掉（v1.7.4 初版踩过）。
						//    ⇒ 诊断数据全部放进 extra（服务端会递归脱敏后原样保留）。
						var data = {};
						for (var i = 0; i < rows.length; i++) {
							// rows 是 [label, value] 二维数组（collectSidebarDiag 的返回格式）
							if (Array.isArray(rows[i]) && rows[i].length >= 2) {
								var key = String(rows[i][0]).replace(/[:\s]+$/g, '');
								data[key] = String(rows[i][1]);
							}
						}
						var entry = {
							t: Date.now(),
							level: 'info',
							kind: 'sidebar-diag',
							msg: 'sidebar state sample',
							extra: data,
						};
						queue.push(entry);
						if (queue.length > MAX_QUEUE) queue.splice(0, queue.length - MAX_QUEUE);
					} catch (e) {}
				}

				function flush () {
					if (queue.length === 0) return;
					var batch = queue.slice(0);
					queue.length = 0;
					try {
						var body = JSON.stringify({
							kind: 'sidebar-diag',
							ua: (typeof navigator !== 'undefined' && navigator.userAgent) || '',
							entries: batch,
						});
						// 用 fetch；失败静默（下个周期再说）
						if (typeof win.fetch === 'function') {
							win.fetch(endpoint, {
								method: 'POST',
								headers: { 'Content-Type': 'application/json' },
								body: body,
								credentials: 'include',
							}).then(function () { uploaded += batch.length }).catch(function () {
								// 失败：丢弃这批（不重投，避免无限堆积）
							});
						}
					} catch (e) {}
				}

				function start () {
					if (collectTimer !== null) return;
					sample();
					try { collectTimer = win.setInterval(sample, COLLECT_MS) } catch (e1) { collectTimer = null; }
					try { flushTimer = win.setInterval(flush, FLUSH_MS) } catch (e2) { flushTimer = null; }
				}

				function stop () {
					if (collectTimer !== null) { try { win.clearInterval(collectTimer) } catch (e) {} collectTimer = null; }
					if (flushTimer !== null) { try { win.clearInterval(flushTimer) } catch (e) {} flushTimer = null; }
				}

				// 页面卸载前尝试发一次（sendBeacon 在后台也可靠）
				try {
					win.addEventListener('beforeunload', function () {
						if (queue.length === 0) return;
						try {
							var body = JSON.stringify({ kind: 'sidebar-diag', ua: (typeof navigator !== 'undefined' && navigator.userAgent) || '', entries: queue });
							if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
								navigator.sendBeacon(endpoint, new Blob([body], { type: 'application/json' }));
								queue.length = 0;
							}
						} catch (e) {}
					});
				} catch (eAdd) {}

				return {
					start: start,
					stop: stop,
					status: function () { return { queued: queue.length, uploaded: uploaded }; },
				};
			}

		/** localStorage 键：Android 抽屉的「诊断模式」开关读写它。 */
		var SIDEBAR_DIAG_STORAGE_KEY = 'dsh-postapi-sidebar-diag';

		function setupSidebarDiag (ctx, opts) {
			var o = opts || {};
			var win = o.win || (typeof window !== 'undefined' ? window : undefined);
			var doc = o.doc || (typeof document !== 'undefined' ? document : undefined);
			var log = typeof o.log === 'function' ? o.log : function () {};

			// ① 开关：**默认关闭**。两种方式开启（任一即可）：
			//      a) URL 参数 ?sidebardiag=1        —— 临时手段，刷新即失效
			//      b) localStorage['dsh-postapi-sidebar-diag'] = 'on'
			//         ↑ Android 抽屉里的「诊断模式」开关写的就是这个键
			//    读取异常一律当作「不装」（fail-closed）—— 诊断浮层不该意外出现。
			var search = typeof o.search === 'string' ? o.search : '';
			if (typeof o.search !== 'string') {
				try {
					search = win && win.location && typeof win.location.search === 'string' ? win.location.search : '';
				} catch (eSearch) { search = ''; }
			}
			var urlOn = /[?&]sidebardiag=1(?:&|$)/i.test(String(search || ''));
			var storageOn = false;
			if (!urlOn) {
				try {
					var st = o.storage !== undefined ? o.storage : (typeof localStorage !== 'undefined' ? localStorage : null);
					if (st && typeof st.getItem === 'function' && st.getItem(SIDEBAR_DIAG_STORAGE_KEY) === 'on') storageOn = true;
				} catch (eLs) { storageOn = false; }
			}
			var requested = urlOn || storageOn;
			if (!win || !doc || typeof doc.createElement !== 'function' || !doc.body) {
				return { active: false, reason: 'no-dom' };
			}

			// ⚠️ 即便 requested = false，也要返回**完整的接口对象**（含 enable/disable）。
			//    为什么：Android 抽屉里的开关靠 __postapiSidebarDiag.enable() 开启诊断。
			//    若未开启时返回裸的 {active:false}，那个对象上就没有 enable ——
			//    App 永远够不着它，用户拨开关只会看到「接口未就绪」，形成死锁。
			//    （v1.7.1 初版正是这个 bug，v1.7.2 修正）
			//    requested = false 时只是**不挂浮层、不起定时器**（零开销），接口仍然可用。

			var container = null;
			var timer = null;
			var disposed = false;

			function readRows () {
				return collectSidebarDiag({
					doc: doc,
					win: win,
					handle: typeof o.handle === 'function' ? o.handle() : (o.handle !== undefined ? o.handle : postapiAutoCollapseHandle),
					lastDiag: o.lastDiag !== undefined ? o.lastDiag : postapiAutoCollapseLastDiag,
					state: o.state !== undefined ? o.state : postapiAutoCollapseState,
				});
			}

			function refresh () {
				if (disposed) return;
				// requested=false 时不画浮层（零开销）。用户开开关后调 enable() 会把
				// requested 置 true 并重新拉起定时器。
				if (!requested) return;
				try {
					if (!container || !container.parentNode) {
						container = doc.createElement('div');
						container.setAttribute('data-postapi-sidebar-diag', '1');
						// 样式全部 inline：不依赖插件 CSS 是否注入成功（真机排障时少一个变量）
						container.style.position = 'fixed';
						container.style.top = '8px';
						container.style.right = '8px';
						container.style.zIndex = '99999';
						container.style.background = 'rgba(0,0,0,.82)';
						container.style.color = '#fff';
						container.style.fontSize = '11px';
						container.style.fontFamily = 'monospace';
						container.style.lineHeight = '1.45';
						container.style.padding = '6px 8px';
						container.style.borderRadius = '6px';
						container.style.pointerEvents = 'none'; // 不能挡住用户操作
						container.style.maxWidth = '46vw';
						container.style.wordBreak = 'break-all';
						container.style.whiteSpace = 'normal';
						doc.body.appendChild(container);
					}
					renderSidebarDiag(container, readRows(), null);
				} catch (eRefresh) {
					// 浮层坏了不能影响任何东西：直接静默（最多是看不到诊断）
					log('sidebardiag refresh error: ' + String(eRefresh && eRefresh.message ? eRefresh.message : eRefresh));
				}
			}

			// 启动：只在已请求时真正跑（未请求 = 零开销，但接口仍可被 App 调）
			function startTimer () {
				if (timer !== null) return;
				try {
					timer = win.setInterval(refresh, typeof o.intervalMs === 'number' ? o.intervalMs : 500);
				} catch (eTimer) { timer = null; }
			}
			function stopTimer () {
				if (timer !== null) {
					try { win.clearInterval(timer) } catch (eClear) {}
					timer = null;
				}
			}
			// 上报器：把采集数据定期发到 /client-log（服务端已允许 kind='sidebar-diag'）
			// apiPrefix 由 apply() 传入；拿不到就不上报，只保留浮层。
			var reporter = null;
			try {
				reporter = startSidebarDiagReporter({ win: win, doc: doc });
			} catch (eRep) { reporter = null; }

			if (requested) { refresh(); startTimer(); if (reporter) try { reporter.start() } catch (eRs) {} }

			return {
				active: true,
				__refresh: refresh,

				/**
				 * Android 抽屉里的开关会调这三个方法。
				 *
				 * 为什么状态存在 localStorage 而不是内存变量：
				 *   页面重载后 JS 状态全丢，但用户的开关意图要保留 —— 存在 localStorage
				 *   才能在重载后由上面的 ① 自动装回来。
				 *
				 * enable() 幂等：已经装了（本次已 active）时只回写 localStorage，不重复挂载。
				 * 注意本函数只在「已装」时返回这个对象；未装时 setupSidebarDiag 返回
				 * {active:false}，Android 侧据此显示「诊断不可用」。
				 */
				isEnabled: function () { return requested && !disposed },
				enable: function () {
					try {
						var st = typeof localStorage !== 'undefined' ? localStorage : null;
						if (st && typeof st.setItem === 'function') st.setItem(SIDEBAR_DIAG_STORAGE_KEY, 'on');
					} catch (eSet) {}
					// 关键：若安装时未请求（requested=false），这里要把状态翻过来并真正启动，
					// 否则用户拨了开关却什么都看不到 —— 那正是 v1.7.1 的死锁。
					disposed = false;
					requested = true;
					try { refresh() } catch (eR) {}
					startTimer();
					if (reporter) try { reporter.start() } catch (eRs) {}
					return true;
				},
				disable: function () {
					try {
						var st = typeof localStorage !== 'undefined' ? localStorage : null;
						if (st && typeof st.setItem === 'function') st.setItem(SIDEBAR_DIAG_STORAGE_KEY, 'off');
					} catch (eSet) {}
					requested = false;
					stopTimer();
					if (reporter) try { reporter.flushNow ? reporter.flushNow() : null; reporter.stop() } catch (eDp) {}
					try { if (container && container.parentNode) container.parentNode.removeChild(container) } catch (eRemove) {}
					container = null;
					return true;
				},
				status: function () {
					return { enabled: requested && !disposed, collected: 0, uploaded: 0 };
				},
				dispose: function () {
					disposed = true;
					try { if (timer !== null) win.clearInterval(timer) } catch (eClear) {}
					timer = null;
					try { if (container && container.parentNode) container.parentNode.removeChild(container) } catch (eRemove) {}
					container = null;
				},
			};
		}


		// ============================================================================
		// Cordis 客户端插件生命周期注册
		// ============================================================================
		const name = 'postapi-bridge';
		const inject = ['slots'];

		function apply(ctx, config) {
			// ---- 客户端日志自动上报（v1.4.0 引入，v1.6.0 起**默认关闭**）----
			// 位置：apply 的**最前面**，理由与 polyfill 相同 —— 一旦启用，越早装上越能捕获
			//   页面加载早期发生的长任务与错误（用户抱怨的"卡"往往就在首屏）。
			//
			// 🔴 v1.6.0 开关（**默认关闭**）：判定全部收敛在 resolveClientLogEnabled() 里，
			//   优先级 URL 参数 > localStorage > **默认 off**：
			//   // 默认关闭。开启方式（任选其一）：
			//   //   ?clientlog=on  URL 参数
			//   //   localStorage.setItem('dsh-postapi-client-log', 'on')
			//   // 关闭：?clientlog=off 或 localStorage 设 'off'
			//   ④ 配置项 clientLogAutoReport 若为 false 仍可强制关（向下兼容；为 true 也**不**能
			//      绕过 URL 的 off —— 现场关掉必须立即生效；宿主目前不透传 config，见文件末说明）
			// 为什么改成关闭而不是优化：v1.4.0 的采集器常驻 rAF 循环，用户实测反而加剧卡顿
			//   （longtask 74 → 1048，FPS 1-5）。诊断工具不该拖慢生产 —— 需要时再显式打开。
			//   采集器内部实现保持原样，不在常态路径上运行。
			//
			// 全部包在 try/catch 里：诊断能力绝不能影响插件其余部分（尤其不能白屏）。
			try {
				var clResolved = resolveClientLogEnabled();
				var clEnabled = clResolved.enabled;
				if (config && config.clientLogAutoReport === false) clEnabled = false;
				if (clEnabled && typeof window !== 'undefined') {
					var clCollector = createClientLogCollector({ window: window, document: typeof document === 'undefined' ? undefined : document });
					window.__postapiClientLog = installClientLogAutoReport(clCollector);
					// 环境快照：立即上报一次（kind: snapshot）。
					// 入口即证据 —— 用户说"卡"时，第一件事是知道他用的是哪个内核的 WebView。
					clCollector.report('snapshot', [{
						t: Date.now(), level: 'info', kind: 'snapshot', msg: 'page load snapshot',
					}], true);
				}
			} catch (eCL) {
				// 静默：采集器装不上就退化为"无日志上报"，其它功能一切照旧
			}

			// ---- v1.7.0 切换会话后自动收起左侧栏（仅窄屏）----
			// 只调一行：判定/订阅/边界全部收在 setupAutoCollapseSidebar() 里（见上文该节）。
			// 再包一层 try/catch —— 交互辅助能力，任何意外都不得影响插件其余部分（尤其不能白屏）。
			try {
				window.__postapiAutoCollapse = setupAutoCollapseSidebar(ctx);
			} catch (eAC) {}

			// ---- v1.7.1 诊断浮层（?sidebardiag=1，默认不显示）----
			// 为什么在自动收起**之后**：浮层要读 setupAutoCollapseSidebar 的安装结果与基线，
			//   放后面才能一上来就显示「autocollapse: active / no-layout …」而不是空白。
			// 单独 try/catch：浮层是纯诊断，坏了也不能影响插件其余部分（尤其不能白屏）。
			try {
				window.__postapiSidebarDiag = setupSidebarDiag(ctx);
			} catch (eDiag) {}

			// 非侵入补丁：在全局作用域安全劫持 connection.isLoopback 与 settingsDescribeMirror
			try {
				if (typeof window !== 'undefined') {
					// 监听并确保后续创建或存在的 connection 均标记为 loopback
					const pollConnection = () => {
						const conn = ctx.get('connection');
						if (conn) {
							try {
								Object.defineProperty(conn, 'isLoopback', {
									get: () => true,
									configurable: true,
								});
							} catch (e) {
								conn.isLoopback = true;
							}
						}
						const ss = ctx.get('settingsScope');
						if (ss && typeof ss.describe === 'function') {
							const mirror = ss.describe();
							if (mirror && mirror.persistence !== 'host') {
								mirror.persistence = 'host';
								if (mirror.store && typeof mirror.store.update === 'function') {
									mirror.store.update((s) => {
										if (s.status === 'unavailable') s.status = 'idle';
									});
								}
								void mirror.load();
							}
						}
					};
					pollConnection();
					setTimeout(pollConnection, 100);
					setTimeout(pollConnection, 500);
					setTimeout(pollConnection, 1500);

					// ============================================================
					// 「未登录自动跳登录页」：包装全局 fetch，捕获 DSH 核心 /api
					// RPC 的 401/403。仅当浏览器当前没有会话 cookie（且不在登录页）
					// 才把用户带去 /login —— 有会话的 401（如 stepup 缺当日解锁）
					// 不狂跳，避免敏感操作被反复弹回登录页。
					// 例：会话过期后刷新页面，前端 RPC 全部 401 → 自动落到登录页。
					// ============================================================
					const SESSION_COOKIE = 'dsh_postapi_session';
					const hasSessionCookie = () => {
						const m = document.cookie.match(new RegExp('(?:^|;\\s*)' + SESSION_COOKIE + '=([^;]*)'));
						return !!(m && m[1] !== '');
					};
					const isLoginPage = () => {
						try {
							const p = window.location.pathname;
							return p === '/login' || p === '/login/' || p.startsWith('/login/stepup');
						} catch { return false; }
					};
					let redirectingToLogin = false;
					const origFetch = window.fetch.bind(window);
					window.fetch = async (input, init) => {
						const res = await origFetch(input, init);
						try {
							const url = typeof input === 'string' ? input
								: (input instanceof URL ? input.href : (input && input.url) || '');
							// 只拦 DSH 核心 /api RPC：非 /api/dsh/v1 机器通道，且非登录页自身。
							if ((res.status === 401 || res.status === 403)
								&& url.indexOf('/api/') === 0
								&& url.indexOf('/api/dsh/v1/') !== 0
								&& !hasSessionCookie()
								&& !isLoginPage()
								&& !redirectingToLogin) {
								redirectingToLogin = true;
								setTimeout(() => { redirectingToLogin = false; }, 3000);
								window.location.href = '/login';
							}
						} catch (err) {}
						return res;
					};
				}
			} catch (err) {}

			// 将「账号管理」作为独立的分类页面注入至 DSH 主设置面板（settings.section）
			ctx.slots.inject('settings.section', function* () {
				yield ctx.slots.register({
					name: 'settings.section',
					id: 'postapi-bridge',
					order: 45, // 紧跟在 plugins / agent-presets 附近
					label: () => '账号管理',
				}, (ownerProps) => e(UserManagementSection, Object.assign({ config: config }, ownerProps)));
			});

			// ---- v0.10.0 交付物文件卡片「下载」按钮 ----
			// 官方 slot：deliverables.file.actions（kind 'list' / scope 'session'）。
			// 用 ctx.slots.inject 而非直接 register：该 slot 由 ui-deliverables 的
			// turnTail 注册声明（children 表）后才存在；inject 会等声明出现（以及
			// 重新声明）再登记，插件加载顺序因此无关紧要。
			//
			// ⚠️ 显式包 try/catch：这是**锦上添花**的按钮，绝不能让它的注册失败
			//    连累上面的「账号管理」面板或整个 client 插件 apply 抛错。
			//    （inject 本身延迟执行，但 callback 内 register 的同步异常会经
			//    microtask 重投，故这里再自行兜一层。）
			try {
				// v0.11.1 注册留痕：inject 的回调**只在官方 slot 声明出现后才执行**。
				// 因此这行的出现时机本身就是信息：
				//   · 有这行 → 我们的贡献已进入 slot 表（按钮「应该」能渲染）；
				//   · 没这行 + 有 action mounted → 二者矛盾，说明刷新到了旧 bundle；
				//   · 没这行也没 mounted → inject 从未触发（官方 slot 声明没出现，
				//     常见于 ui-deliverables 未加载或版本不匹配）。
				ctx.slots.inject('deliverables.file.actions', () => {
					dlLog('info', 'slot registered: deliverables.file.actions');
					return ctx.slots.register({
						name: 'deliverables.file.actions',
						// list 槽要求唯一 id；与官方 ui-open-in-app 的 'open-in-app' 不冲突，
						// 两者会并排渲染（本按钮 order 更大 → 排在 open/reveal 之后）。
						id: 'postapi-bridge',
						order: 10,
					}, (ownerProps) => e(DownloadFileAction, {
						actionUrl: ownerProps && ownerProps.actionUrl,
						available: ownerProps && ownerProps.available,
						pending: ownerProps && ownerProps.pending,
						onAction: ownerProps && ownerProps.onAction,
						// ⚠️ 事实核对（20261022 读官方源码确认）：client entry 由
						// dsh-client-modules 的 EntriesController.create() 以 `{ name: id }`
						// 创建（entries.ts），**从不携带插件 config**。因此这里读到的
						// config 恒为 undefined，fallback 的 '/api/dsh/v1' 才是实际生效值。
						// 保留这行是因为：① 万一将来上游开始透传 config，无需改代码；
						// ② 把「配置改了 apiPrefix 后按钮走错路」变成一个可读的已知边界。
						// 若确实改了 apiPrefix，下载按钮会 404 → 卡片显示「下载失败」，
						// 此时把下面的 fallback 改成实际前缀即可（后端 apiPrefix 见 lib/index.js 内 apiPrefix 赋值）。
						apiPrefix: config && typeof config.apiPrefix === 'string' ? config.apiPrefix : undefined,
					}));
				});
			} catch (err) {
				// 静默降级：没有下载按钮时，官方卡片上的 open/reveal 完全不受影响
				try { console.warn('[dsh-postapi-bridge] 下载按钮注册失败（已忽略）:', err) } catch (e2) {}
			}

			// ---- v1.1.0 交付物入口：会话顶部紧凑按钮 + 右侧抽屉 ----
			//
			// 形态演进（三轮，最终定于此）：
			//   ① 会话顶部**平铺面板** —— 文件多/描述长时撑破聊天区；
			//   ② 聊天流内 turn 尾平铺卡片 —— 同样占空间，且会话级清单会在每个 turn 重复；
			//   ③ **本版：一个紧凑按钮，点开右侧抽屉**。聊天流只占一行，详情按需展开。
			//
			// 为什么回到 session.header.actions：交付物是**会话级**信息，不是某一轮的信息，
			//   放会话顶部才符合语义；turnTail 是逐 turn 的，天然不适合承载会话级清单。
			//
			// 用 ctx.slots.inject 而非 register：该 slot 由会话界面声明后才存在，
			//   inject 会等声明出现（与上面 deliverables.file.actions 一致）。
			try {
				ctx.slots.inject('conversation.session.header.actions', () => {
					dlLog('info', 'launcher slot: conversation.session.header.actions')
					return ctx.slots.register({
						name: 'conversation.session.header.actions',
						id: 'dsh-postapi-bridge/files',
						order: 40,
						inject: () => ({}),
					}, (slotProps) => e(DeliverablesLauncher, {
						sessionId: slotProps && slotProps.sessionId,
						apiPrefix: config && typeof config.apiPrefix === 'string' ? config.apiPrefix : undefined,
					}))
				})
			} catch (err) {
				// 入口按钮是附加能力，任何意外都不得影响插件其余部分
				dlLog('warn', 'launcher: no slot available ' + String(err && err.message ? err.message : err))
			}
			// ---- v1.5.0 聊天流内「直链下载」卡片（conversation.chat.turnTail）----
			//
			// 为什么是 turnTail：官方交付物卡片也挂在这里，用户「在聊天框里看到卡片」的心智
			//   就在这里；卡片紧跟在产出它的那一轮回复下方，位置最自然。
			//
			// ⚠️ 与 v1.1.0 的回退决定**不矛盾**（见 DeliverablesLauncher 注释）：
			//   当初回退 turnTail 是因为「会话级清单在每个 turn 重复渲染，同一批文件出现几十次」。
			//   本版是按 **turn 字段过滤**后只渲染本轮产出的文件 —— 每个文件只出现在
			//   它自己那一轮，既没有重复，也不需要用户去开抽屉。
			//   （抽屉继续保留：它是会话级汇总视图，两者职责不同。）
			//
			// 独立 DOM（dsa-dlc-*）与独立 try/catch：本卡片任何问题都不得影响官方卡片渲染。
			try {
				ctx.slots.inject('conversation.chat.turnTail', () => {
					dlLog('info', 'card slot: conversation.chat.turnTail')
					return ctx.slots.register({
						name: 'conversation.chat.turnTail',
						id: 'dsh-postapi-bridge/download-cards',
						order: 30,
					}, (slotProps) => e(TurnDeliverablesLinks, {
						turn: slotProps && slotProps.turn,
						sessionId: slotProps && slotProps.sessionId,
						apiPrefix: config && typeof config.apiPrefix === 'string' ? config.apiPrefix : undefined,
					}))
				})
			} catch (err) {
				dlLog('warn', 'card slot: no slot available ' + String(err && err.message ? err.message : err))
			}		}

		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		// v0.10.0：下载按钮的纯函数/工具（仅供测试 import；浏览器运行时不经由此路径）
		exports.__downloadButtonHelpers = __downloadButtonHelpers;
		// v1.1.0：turn 卡片的数据加载器与缓存控制（仅供测试 import）
		exports.__turnCardHelpers = { loadSessionFiles, invalidateFilesCache, __resetFilesCache, FILES_CACHE_TTL_MS };
		// v1.5.0：直链卡片（纯函数 + 组件）仅供测试 import
		exports.__dlCardHelpers = { TurnDeliverablesLinks, pickTurnDownloadFiles, isUsableDownloadUrl };
		// v1.4.0：客户端日志采集器（纯逻辑 + 依赖可注入，仅供测试 import）
		exports.__clientLogHelpers = __clientLogHelpers;
		// v1.7.0：切换会话后自动收起左侧栏（纯决策 + 可注入安装器，仅供测试 import）
		exports.__autoCollapseHelpers = {
			evaluateAutoCollapse: evaluateAutoCollapse,
			setupAutoCollapseSidebar: setupAutoCollapseSidebar,
			resolveAutoCollapseEnabled: resolveAutoCollapseEnabled,
			POSTAPI_AUTOCLOSE_BREAKPOINT: POSTAPI_AUTOCLOSE_BREAKPOINT,
			__getState: function () { return postapiAutoCollapseState; },
			// v1.7.1：诊断浮层（仅供测试 import；浏览器运行时不经由此路径）
			setupSidebarDiag: setupSidebarDiag,
			collectSidebarDiag: collectSidebarDiag,
			readDshViewportWidth: readDshViewportWidth,
			__getLastDiag: function () { return postapiAutoCollapseLastDiag; },
			__getHandle: function () { return postapiAutoCollapseHandle; },
		};
		return module.exports;
	},
});
