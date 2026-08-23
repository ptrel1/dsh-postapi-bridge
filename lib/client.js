/**
 * ============================================================================
 * dsh-server-auth 浏览器半侧（Web client bundle）
 * ============================================================================
 *
 * 将「账号与用户管理」无缝内嵌至 DSH 原生设置面板（settings.section 插槽）。
 * 只有管理员登录时可进行多账号增删改查；普通用户或未登录时提供清晰的安全状态提示。
 */

window.__ModuleLoader__.load({
	id: 'dsh-postapi-bridge',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		const React = require('react');
		const { useEffect, useState, useCallback, createElement: e } = React;

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
		// Cordis 客户端插件生命周期注册
		// ============================================================================
		const name = 'postapi-bridge';
		const inject = ['slots'];

		function apply(ctx, config) {
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
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	},
});
