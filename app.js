// ========== LinearPro — App Logic ==========

const LinearPro = {
    // State
    state: {
        apiKey: null,
        viewer: null,
        organization: null,
        users: [],
        issues: [],
        teams: [],
        workflowStates: [],
        memberData: [],
        globalStatusDist: {},
        priorityDist: {},
        teamDist: {},
        sortBy: 'issues'
    },

    // Shared HTML escape utility
    escapeHtml(text) {
        if (!text) return '';
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    },

    // Chart instances
    charts: {
        status: null,
        workload: null,
        priority: null,
        teams: null
    },

    // ========== API LAYER ==========
    api: {
        async query(graphql, variables = {}) {
            const res = await fetch('https://api.linear.app/graphql', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': LinearPro.state.apiKey
                },
                body: JSON.stringify({ query: graphql, variables })
            });

            if (!res.ok) {
                throw new Error(`API error: ${res.status} ${res.statusText}`);
            }

            const json = await res.json();
            if (json.errors) {
                throw new Error(json.errors[0].message);
            }
            return json.data;
        },

        async testConnection() {
            const data = await this.query(`
                query {
                    viewer { id name email }
                    organization { id name }
                }
            `);
            LinearPro.state.viewer = data.viewer;
            LinearPro.state.organization = data.organization;
            return data;
        },

        async getUsers() {
            let allUsers = [];
            let cursor = null;
            let hasNext = true;

            while (hasNext) {
                const data = await this.query(`
                    query($after: String) {
                        users(first: 100, after: $after) {
                            pageInfo { hasNextPage endCursor }
                            nodes {
                                id name displayName email avatarUrl active admin
                            }
                        }
                    }
                `, { after: cursor });

                allUsers = allUsers.concat(data.users.nodes);
                hasNext = data.users.pageInfo.hasNextPage;
                cursor = data.users.pageInfo.endCursor;
            }

            LinearPro.state.users = allUsers.filter(u => u.active);
            return LinearPro.state.users;
        },

        async getIssues() {
            let allIssues = [];
            let cursor = null;
            let hasNext = true;

            while (hasNext) {
                const data = await this.query(`
                    query($after: String) {
                        issues(first: 100, after: $after) {
                            pageInfo { hasNextPage endCursor }
                            nodes {
                                id identifier title priority priorityLabel
                                assignee { id name }
                                state { id name color type }
                                team { id name key }
                                createdAt updatedAt completedAt startedAt canceledAt
                            }
                        }
                    }
                `, { after: cursor });

                allIssues = allIssues.concat(data.issues.nodes);
                hasNext = data.issues.pageInfo.hasNextPage;
                cursor = data.issues.pageInfo.endCursor;

                // Update loading text with progress
                LinearPro.ui.updateLoadingText(`Fetching issues... (${allIssues.length})`);
            }

            LinearPro.state.issues = allIssues;
            return allIssues;
        },

        async getTeams() {
            const data = await this.query(`
                query {
                    teams(first: 50) {
                        nodes { id name key }
                    }
                }
            `);
            LinearPro.state.teams = data.teams.nodes;
            return data.teams.nodes;
        },

        async getIssueDetail(issueId) {
            const data = await this.query(`
                query($id: String!) {
                    issue(id: $id) {
                        id identifier title description priority priorityLabel
                        estimate url
                        assignee { id name displayName email avatarUrl }
                        state { id name color type }
                        team { id name key }
                        labels { nodes { id name color } }
                        comments { nodes { id body createdAt user { id name displayName avatarUrl } } }
                        history(first: 15) { nodes { id createdAt fromState { name color } toState { name color } actor { name } } }
                        createdAt updatedAt completedAt startedAt
                        cycle { id name number }
                        project { id name }
                        parent { id identifier title }
                        children { nodes { id identifier title state { name color type } } }
                    }
                }
            `, { id: issueId });
            return data.issue;
        },

        async getUserActivity(userId) {
            // Fetch recent issue history entries where this user was the actor
            let allHistory = [];
            let cursor = null;
            let hasNext = true;
            // Fetch up to 300 history entries (3 pages)
            let pages = 0;

            while (hasNext && pages < 3) {
                const data = await this.query(`
                    query($userId: ID, $after: String) {
                        issueHistory(first: 100, after: $after, filter: { actor: { id: { eq: $userId } } }) {
                            pageInfo { hasNextPage endCursor }
                            nodes {
                                id createdAt
                                issue { id identifier title }
                                fromState { name color }
                                toState { name color }
                                addedLabels { id name }
                                removedLabels { id name }
                            }
                        }
                    }
                `, { userId, after: cursor });

                allHistory = allHistory.concat(data.issueHistory.nodes);
                hasNext = data.issueHistory.pageInfo.hasNextPage;
                cursor = data.issueHistory.pageInfo.endCursor;
                pages++;
            }

            return allHistory;
        },

        async getWorkflowStates() {
            const data = await this.query(`
                query {
                    workflowStates(first: 100) {
                        nodes { id name color type position team { id name } }
                    }
                }
            `);
            LinearPro.state.workflowStates = data.workflowStates.nodes;
            return data.workflowStates.nodes;
        }
    },

    // ========== DATA PROCESSING ==========
    processData() {
        const { users, issues } = this.state;

        // Group issues by assignee
        const issuesByUser = {};
        issues.forEach(issue => {
            const uid = issue.assignee?.id;
            if (!uid) return;
            if (!issuesByUser[uid]) issuesByUser[uid] = [];
            issuesByUser[uid].push(issue);
        });

        // Build member data
        this.state.memberData = users.map(user => {
            const userIssues = issuesByUser[user.id] || [];
            const statusBreakdown = {};
            const statusColors = {};

            userIssues.forEach(i => {
                const name = i.state?.name || 'Unknown';
                statusBreakdown[name] = (statusBreakdown[name] || 0) + 1;
                if (i.state?.color) statusColors[name] = i.state.color;
            });

            return {
                ...user,
                issues: userIssues,
                issueCount: userIssues.length,
                statusBreakdown,
                statusColors
            };
        });

        // Global status distribution
        this.state.globalStatusDist = {};
        const statusColorMap = {};
        issues.forEach(i => {
            const name = i.state?.name || 'Unknown';
            this.state.globalStatusDist[name] = (this.state.globalStatusDist[name] || 0) + 1;
            if (i.state?.color) statusColorMap[name] = i.state.color;
        });
        this.state.statusColorMap = statusColorMap;

        // Priority distribution
        this.state.priorityDist = {};
        issues.forEach(i => {
            const label = i.priorityLabel || 'No Priority';
            this.state.priorityDist[label] = (this.state.priorityDist[label] || 0) + 1;
        });

        // Team distribution
        this.state.teamDist = {};
        issues.forEach(i => {
            const name = i.team?.name || 'Unassigned';
            this.state.teamDist[name] = (this.state.teamDist[name] || 0) + 1;
        });
    },

    // ========== UI RENDERING ==========
    ui: {
        showView(viewId) {
            document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
            document.getElementById(viewId).classList.add('active');
        },

        showLoading(show) {
            const overlay = document.getElementById('loading-overlay');
            if (show) {
                overlay.classList.remove('hidden');
            } else {
                overlay.classList.add('hidden');
            }
        },

        updateLoadingText(text) {
            document.getElementById('loading-text').textContent = text;
        },

        showLoginError(msg) {
            const el = document.getElementById('login-error');
            el.textContent = msg;
            el.classList.remove('hidden');
        },

        hideLoginError() {
            document.getElementById('login-error').classList.add('hidden');
        },

        toast(message, type = 'info') {
            const container = document.getElementById('toast-container');
            const toast = document.createElement('div');
            toast.className = `toast ${type}`;
            toast.innerHTML = `<i class="fas fa-${type === 'success' ? 'check-circle' : type === 'error' ? 'exclamation-circle' : 'info-circle'}"></i> ${message}`;
            container.appendChild(toast);

            setTimeout(() => {
                toast.classList.add('leaving');
                setTimeout(() => toast.remove(), 300);
            }, 3500);
        },

        renderDashboard() {
            const { organization } = LinearPro.state;
            document.getElementById('org-name').textContent = organization?.name || '';

            this.renderStats();
            this.renderMemberCards();
            LinearPro.renderCharts();

            this.showView('dashboard-view');
        },

        renderStats() {
            const { memberData, issues } = LinearPro.state;

            const completed = issues.filter(i => i.state?.type === 'completed').length;
            const inProgress = issues.filter(i => i.state?.type === 'started').length;

            this.animateCounter('stat-members', memberData.length);
            this.animateCounter('stat-issues', issues.length);
            this.animateCounter('stat-completed', completed);
            this.animateCounter('stat-in-progress', inProgress);
        },

        animateCounter(elementId, target) {
            const el = document.getElementById(elementId);
            const duration = 1200;
            const start = performance.now();
            const initial = 0;

            function update(now) {
                const elapsed = now - start;
                const progress = Math.min(elapsed / duration, 1);
                // Ease out cubic
                const eased = 1 - Math.pow(1 - progress, 3);
                el.textContent = Math.round(initial + (target - initial) * eased);
                if (progress < 1) requestAnimationFrame(update);
            }
            requestAnimationFrame(update);
        },

        renderMemberCards() {
            const grid = document.getElementById('members-grid');
            grid.innerHTML = '';

            let members = [...LinearPro.state.memberData];

            // Sort
            if (LinearPro.state.sortBy === 'issues') {
                members.sort((a, b) => b.issueCount - a.issueCount);
            } else {
                members.sort((a, b) => (a.displayName || a.name).localeCompare(b.displayName || b.name));
            }

            if (members.length === 0) {
                grid.innerHTML = `
                    <div class="empty-state">
                        <i class="fas fa-users-slash"></i>
                        <p>No team members found</p>
                    </div>
                `;
                return;
            }

            members.forEach((member, index) => {
                const card = document.createElement('div');
                card.className = 'member-card';
                card.style.animationDelay = `${index * 0.07}s`;

                const memberName = member.displayName || member.name;
                const avatar = member.avatarUrl
                    ? `<img class="avatar" src="${member.avatarUrl}" alt="${LinearPro.escapeHtml(memberName)}" data-fallback-name="${LinearPro.escapeHtml(memberName)}">`
                    : LinearPro.ui.createInitialsAvatarHTML(memberName);

                // Build status bar segments
                const total = member.issueCount;
                let statusBarHTML = '';
                let statusTagsHTML = '';

                if (total > 0) {
                    const entries = Object.entries(member.statusBreakdown);
                    entries.sort((a, b) => b[1] - a[1]);

                    entries.forEach(([name, count]) => {
                        const pct = (count / total * 100).toFixed(1);
                        const color = member.statusColors[name] || '#6e7681';
                        statusBarHTML += `<div class="status-bar-segment" style="width:${pct}%;background:${color}" title="${LinearPro.escapeHtml(name)}: ${count}"></div>`;
                        statusTagsHTML += `<span class="status-tag"><span class="status-dot" style="background:${color}"></span>${LinearPro.escapeHtml(name)} ${count}</span>`;
                    });
                }

                card.innerHTML = `
                    <div class="card-header">
                        ${avatar}
                        <div class="member-info">
                            <h3>${LinearPro.escapeHtml(member.displayName || member.name)}</h3>
                            <div class="member-email">${LinearPro.escapeHtml(member.email || '')}</div>
                        </div>
                    </div>
                    <div class="card-body">
                        <div class="issue-count-row">
                            <span class="issue-count">${member.issueCount}</span>
                            <span class="issue-count-label">assigned issues</span>
                        </div>
                        <div class="status-bar">${statusBarHTML}</div>
                        <div class="status-list">${statusTagsHTML}</div>
                    </div>
                `;

                // Avatar fallback handler
                const img = card.querySelector('img.avatar[data-fallback-name]');
                if (img) {
                    img.addEventListener('error', function() {
                        this.replaceWith(LinearPro.ui.createInitialsAvatar(this.dataset.fallbackName));
                    });
                }

                // Click to open detail modal
                card.addEventListener('click', () => {
                    LinearPro.modal.open(member);
                });

                grid.appendChild(card);
            });
        },

        createInitialsAvatarHTML(name) {
            const initials = name.split(' ').map(w => w[0]).join('').substring(0, 2).toUpperCase();
            const colors = ['#5E6AD2', '#3fb950', '#d29922', '#f85149', '#58a6ff', '#bc8cff', '#db6d28', '#7ee787'];
            const hash = name.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0);
            const color = colors[hash % colors.length];
            return `<div class="avatar-initials" style="background:${color}">${initials}</div>`;
        },

        createInitialsAvatar(name) {
            const div = document.createElement('div');
            div.className = 'avatar-initials';
            const initials = name.split(' ').map(w => w[0]).join('').substring(0, 2).toUpperCase();
            const colors = ['#5E6AD2', '#3fb950', '#d29922', '#f85149', '#58a6ff', '#bc8cff', '#db6d28', '#7ee787'];
            const hash = name.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0);
            div.style.background = colors[hash % colors.length];
            div.textContent = initials;
            return div;
        }
    },

    // ========== MEMBER DETAIL MODAL ==========
    modal: {
        memberCharts: { status: null, priority: null },
        currentStatusFilter: 'all',
        currentTimePeriod: 'all',
        currentMember: null,
        activityData: null,      // user's activity history from API
        activityLoading: false,
        workedOnIssueIds: null,  // Set of issue IDs user actually worked on in period

        open(member) {
            this.currentMember = member;
            this.currentStatusFilter = 'all';
            this.currentTimePeriod = 'all';
            this.activityData = null;
            this.workedOnIssueIds = null;
            this.render(member);

            const modal = document.getElementById('member-modal');
            modal.classList.add('active');
            document.body.style.overflow = 'hidden';

            // Fetch activity in background for precise filtering
            this.fetchActivity(member);
        },

        close() {
            const modal = document.getElementById('member-modal');
            modal.classList.remove('active');
            document.body.style.overflow = '';
            Object.values(this.memberCharts).forEach(c => c?.destroy());
            this.memberCharts = { status: null, priority: null };
        },

        async fetchActivity(member) {
            this.activityLoading = true;
            try {
                const history = await LinearPro.api.getUserActivity(member.id);
                this.activityData = history;

                // Show a subtle indicator that activity data is ready
                const badge = document.getElementById('activity-ready-badge');
                if (badge) {
                    badge.style.display = 'inline-flex';
                    badge.classList.add('activity-loaded');
                }
            } catch (err) {
                console.warn('Could not fetch activity data:', err);
                this.activityData = [];
            }
            this.activityLoading = false;
        },

        // Get cutoff date for a time period
        getCutoffDate(period) {
            if (period === 'all') return null;
            const now = new Date();
            const days = { 'today': 0, '3d': 3, '7d': 7, '15d': 15 };
            const d = new Date(now);
            if (period === 'today') {
                d.setHours(0, 0, 0, 0);
            } else {
                d.setDate(d.getDate() - (days[period] || 0));
                d.setHours(0, 0, 0, 0);
            }
            return d;
        },

        // Filter issues based on time period using both updatedAt and activity data
        getFilteredIssues(member, period) {
            const allIssues = member.issues || [];
            if (period === 'all') return allIssues;

            const cutoff = this.getCutoffDate(period);
            if (!cutoff) return allIssues;

            // Build a set of issue IDs this user actually touched in the period
            // from activity history (precise — shows actual state changes, comments, etc.)
            const touchedIds = new Set();

            if (this.activityData) {
                this.activityData.forEach(h => {
                    const histDate = new Date(h.createdAt);
                    if (histDate >= cutoff && h.issue?.id) {
                        touchedIds.add(h.issue.id);
                    }
                });
            }

            // Also include issues that have updatedAt/completedAt/startedAt within range
            return allIssues.filter(issue => {
                // Activity-based match (most precise)
                if (touchedIds.has(issue.id)) return true;

                // Fallback: check timestamps on the issue itself
                if (issue.updatedAt && new Date(issue.updatedAt) >= cutoff) return true;
                if (issue.completedAt && new Date(issue.completedAt) >= cutoff) return true;
                if (issue.startedAt && new Date(issue.startedAt) >= cutoff) return true;

                return false;
            });
        },

        // Get activity summary for a time period
        getActivitySummary(member, period) {
            const cutoff = this.getCutoffDate(period);
            const allIssues = member.issues || [];

            if (period === 'all' || !cutoff) {
                const completed = allIssues.filter(i => i.state?.type === 'completed').length;
                const inProgress = allIssues.filter(i => i.state?.type === 'started').length;
                return {
                    workedOn: allIssues.length,
                    completed,
                    inProgress,
                    statusChanges: '—'
                };
            }

            const filtered = this.getFilteredIssues(member, period);
            const completed = filtered.filter(i => i.completedAt && new Date(i.completedAt) >= cutoff).length;
            const inProgress = filtered.filter(i => i.state?.type === 'started').length;

            // Count status transitions from activity data
            let statusChanges = 0;
            if (this.activityData) {
                this.activityData.forEach(h => {
                    if (new Date(h.createdAt) >= cutoff && (h.fromState || h.toState)) {
                        statusChanges++;
                    }
                });
            }

            return { workedOn: filtered.length, completed, inProgress, statusChanges };
        },

        render(member) {
            const content = document.getElementById('modal-content');
            const name = member.displayName || member.name;

            // Avatar
            const avatarHTML = member.avatarUrl
                ? `<img class="modal-avatar" src="${member.avatarUrl}" alt="${LinearPro.escapeHtml(name)}" onerror="this.style.display='none';this.nextElementSibling.style.display='flex';">
                   <div class="modal-avatar-initials" style="display:none;background:${this.getColor(name)}">${this.getInitials(name)}</div>`
                : `<div class="modal-avatar-initials" style="background:${this.getColor(name)}">${this.getInitials(name)}</div>`;

            content.innerHTML = `
                <!-- Profile Header -->
                <div class="modal-profile">
                    ${avatarHTML}
                    <div class="modal-profile-info">
                        <h2>${LinearPro.escapeHtml(name)}</h2>
                        <div class="modal-email">${LinearPro.escapeHtml(member.email || '')}</div>
                        ${member.admin ? '<div class="modal-role"><i class="fas fa-shield-halved"></i> Admin</div>' : '<div class="modal-role"><i class="fas fa-user"></i> Member</div>'}
                    </div>
                </div>

                <!-- Time Period Filter -->
                <div class="time-filter-section">
                    <div class="time-filter-header">
                        <span class="time-filter-label"><i class="fas fa-calendar-days"></i> Activity Period</span>
                        <span id="activity-ready-badge" class="activity-badge" style="display:none">
                            <i class="fas fa-circle-check"></i> Activity synced
                        </span>
                    </div>
                    <div class="time-filter-btns" id="time-filter-btns">
                        <button class="time-btn active" data-period="all">All Time</button>
                        <button class="time-btn" data-period="today">Today</button>
                        <button class="time-btn" data-period="3d">Last 3 Days</button>
                        <button class="time-btn" data-period="7d">Last 7 Days</button>
                        <button class="time-btn" data-period="15d">Last 15 Days</button>
                    </div>
                </div>

                <!-- Dynamic Content (stats, charts, table) re-renders on period change -->
                <div id="modal-dynamic-content"></div>
            `;

            // Render dynamic section for the current period
            this.renderDynamic(member, 'all');

            // Bind time filter buttons
            content.querySelectorAll('.time-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    content.querySelectorAll('.time-btn').forEach(b => b.classList.remove('active'));
                    btn.classList.add('active');
                    this.currentTimePeriod = btn.dataset.period;
                    this.currentStatusFilter = 'all';
                    this.renderDynamic(member, btn.dataset.period);
                });
            });
        },

        renderDynamic(member, period) {
            const container = document.getElementById('modal-dynamic-content');
            if (!container) return;

            const issues = this.getFilteredIssues(member, period);
            const summary = this.getActivitySummary(member, period);
            const allIssues = member.issues || [];

            // Period label for display
            const periodLabels = {
                'all': 'All Time', 'today': 'Today', '3d': 'Last 3 Days', '7d': 'Last 7 Days', '15d': 'Last 15 Days'
            };

            // Compute stats from filtered issues
            const statusBreakdown = {};
            const statusColors = {};
            issues.forEach(i => {
                const sn = i.state?.name || 'Unknown';
                statusBreakdown[sn] = (statusBreakdown[sn] || 0) + 1;
                if (i.state?.color) statusColors[sn] = i.state.color;
            });

            // Status bar
            let statusBarHTML = '';
            if (issues.length > 0) {
                Object.entries(statusBreakdown).sort((a, b) => b[1] - a[1]).forEach(([sn, count]) => {
                    const pct = (count / issues.length * 100).toFixed(1);
                    statusBarHTML += `<div class="status-bar-segment" style="width:${pct}%;background:${statusColors[sn] || '#6e7681'}" title="${sn}: ${count}"></div>`;
                });
            }

            // Status filter buttons
            const statusNames = [...new Set(issues.map(i => i.state?.name || 'Unknown'))];

            // Completion rate for this period
            const completionRate = issues.length > 0 ? Math.round((summary.completed / issues.length) * 100) : 0;

            container.innerHTML = `
                <!-- Stats -->
                <div class="modal-stats">
                    <div class="modal-stat" style="animation-delay:0s">
                        <div class="modal-stat-value" style="color:var(--primary-light)">${summary.workedOn}</div>
                        <div class="modal-stat-label">Worked On</div>
                    </div>
                    <div class="modal-stat" style="animation-delay:0.06s">
                        <div class="modal-stat-value" style="color:var(--green)">${summary.completed}</div>
                        <div class="modal-stat-label">Completed</div>
                    </div>
                    <div class="modal-stat" style="animation-delay:0.12s">
                        <div class="modal-stat-value" style="color:var(--yellow)">${summary.inProgress}</div>
                        <div class="modal-stat-label">In Progress</div>
                    </div>
                    <div class="modal-stat" style="animation-delay:0.18s">
                        <div class="modal-stat-value" style="color:var(--blue)">${summary.statusChanges}</div>
                        <div class="modal-stat-label">Transitions</div>
                    </div>
                </div>

                ${period !== 'all' && allIssues.length !== issues.length ? `
                <div class="period-summary-note">
                    <i class="fas fa-filter"></i>
                    Showing <strong>${issues.length}</strong> of ${allIssues.length} issues active in <strong>${periodLabels[period]}</strong>
                </div>` : ''}

                <!-- Status Bar -->
                <div class="modal-status-bar">${statusBarHTML}</div>

                <!-- Charts -->
                <div class="modal-charts">
                    <div class="modal-chart-card">
                        <h4><i class="fas fa-circle-half-stroke" style="color:var(--primary);margin-right:0.35rem"></i>Status Breakdown</h4>
                        <div class="modal-chart-container">
                            <canvas id="modal-chart-status"></canvas>
                        </div>
                    </div>
                    <div class="modal-chart-card">
                        <h4><i class="fas fa-flag" style="color:var(--orange);margin-right:0.35rem"></i>Priority Distribution</h4>
                        <div class="modal-chart-container">
                            <canvas id="modal-chart-priority"></canvas>
                        </div>
                    </div>
                </div>

                <!-- Issues Table -->
                <div class="modal-issues-header">
                    <h3><i class="fas fa-list-check"></i> Issues (${issues.length})</h3>
                    <div class="modal-filter-btns">
                        <button class="modal-filter-btn active" data-filter="all">All</button>
                        ${statusNames.map(s => `<button class="modal-filter-btn" data-filter="${s}">${s}</button>`).join('')}
                    </div>
                </div>
                <div class="issues-scroll">
                    ${issues.length > 0 ? `
                    <table class="issues-table">
                        <thead>
                            <tr>
                                <th>ID</th>
                                <th>Title</th>
                                <th>Status</th>
                                <th>Priority</th>
                                <th>Team</th>
                                <th>Updated</th>
                            </tr>
                        </thead>
                        <tbody id="modal-issues-tbody"></tbody>
                    </table>
                    ` : `<div class="no-issues-msg"><i class="fas fa-inbox" style="font-size:1.5rem;display:block;margin-bottom:0.5rem;opacity:0.3"></i>No issues found in this period</div>`}
                </div>
            `;

            // Render rows
            if (issues.length > 0) {
                this.renderIssueRows(issues);
            }

            // Render charts with filtered data
            requestAnimationFrame(() => requestAnimationFrame(() => this.renderMemberCharts(issues, statusBreakdown, statusColors)));

            // Bind status filter buttons
            container.querySelectorAll('.modal-filter-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    container.querySelectorAll('.modal-filter-btn').forEach(b => b.classList.remove('active'));
                    btn.classList.add('active');
                    const filter = btn.dataset.filter;
                    this.currentStatusFilter = filter;
                    const filtered = filter === 'all' ? issues : issues.filter(i => (i.state?.name || 'Unknown') === filter);
                    this.renderIssueRows(filtered);
                });
            });
        },

        renderIssueRows(issues) {
            const tbody = document.getElementById('modal-issues-tbody');
            if (!tbody) return;

            const priorityColors = {
                'Urgent': 'var(--red)', 'High': 'var(--orange)',
                'Medium': 'var(--yellow)', 'Low': 'var(--blue)', 'No Priority': 'var(--text-muted)'
            };
            const priorityIcons = {
                'Urgent': 'fa-circle-exclamation', 'High': 'fa-arrow-up',
                'Medium': 'fa-minus', 'Low': 'fa-arrow-down', 'No Priority': 'fa-circle'
            };

            const newTbody = tbody.cloneNode(false);
            tbody.parentNode.replaceChild(newTbody, tbody);
            newTbody.id = 'modal-issues-tbody';

            newTbody.addEventListener('click', (e) => {
                const row = e.target.closest('tr[data-issue-id]');
                if (row) LinearPro.ticketPanel.open(row.dataset.issueId);
            });

            newTbody.innerHTML = issues.map((issue, idx) => {
                const statusName = issue.state?.name || 'Unknown';
                const statusColor = issue.state?.color || '#6e7681';
                const pLabel = issue.priorityLabel || 'No Priority';
                const pColor = priorityColors[pLabel] || 'var(--text-muted)';
                const pIcon = priorityIcons[pLabel] || 'fa-circle';
                const teamName = issue.team?.name || '—';
                const updated = issue.updatedAt ? this.timeAgo(new Date(issue.updatedAt)) : '—';

                return `
                    <tr style="animation-delay:${idx * 0.025}s" data-issue-id="${issue.id}">
                        <td><span style="color:var(--primary-light);font-weight:600;font-size:0.75rem;font-family:monospace">${issue.identifier || ''}</span></td>
                        <td class="issue-title-cell" title="${LinearPro.escapeHtml(issue.title)}">${LinearPro.escapeHtml(issue.title)}</td>
                        <td>
                            <span class="issue-status-badge" style="background:${statusColor}22;color:${statusColor}">
                                <span class="status-dot" style="background:${statusColor}"></span>
                                ${statusName}
                            </span>
                        </td>
                        <td><span class="issue-priority-badge" style="color:${pColor}"><i class="fas ${pIcon} priority-icon"></i> ${pLabel}</span></td>
                        <td><span class="issue-team-badge">${teamName}</span></td>
                        <td><span class="issue-date">${updated}</span></td>
                    </tr>
                `;
            }).join('');
        },

        renderMemberCharts(issues, statusBreakdown, statusColors) {
            Object.values(this.memberCharts).forEach(c => c?.destroy());
            if (issues.length === 0) return;

            const chartTextColor = '#8b949e';

            const sLabels = Object.keys(statusBreakdown);
            const sData = Object.values(statusBreakdown);
            const sColors = sLabels.map(l => statusColors[l] || '#6e7681');

            const statusCanvas = document.getElementById('modal-chart-status');
            if (statusCanvas) {
                this.memberCharts.status = new Chart(statusCanvas, {
                    type: 'doughnut',
                    data: { labels: sLabels, datasets: [{ data: sData, backgroundColor: sColors, borderWidth: 0, hoverOffset: 6 }] },
                    options: {
                        responsive: true, maintainAspectRatio: false, cutout: '58%',
                        plugins: { legend: { position: 'right', labels: { padding: 10, usePointStyle: true, pointStyleWidth: 8, font: { size: 11 }, color: chartTextColor } } },
                        animation: { duration: 800 }
                    }
                });
            }

            const priorityOrder = ['Urgent', 'High', 'Medium', 'Low', 'No Priority'];
            const pColorMap = { 'Urgent': '#f87171', 'High': '#f97316', 'Medium': '#fbbf24', 'Low': '#60a5fa', 'No Priority': '#5a6270' };
            const pDist = {};
            issues.forEach(i => { const l = i.priorityLabel || 'No Priority'; pDist[l] = (pDist[l] || 0) + 1; });
            const pLabels = priorityOrder.filter(p => pDist[p]);
            const pData = pLabels.map(p => pDist[p]);
            const pColors = pLabels.map(p => pColorMap[p] || '#5a6270');

            const priorityCanvas = document.getElementById('modal-chart-priority');
            if (priorityCanvas) {
                this.memberCharts.priority = new Chart(priorityCanvas, {
                    type: 'bar',
                    data: { labels: pLabels, datasets: [{ data: pData, backgroundColor: pColors, borderRadius: 6, borderSkipped: false }] },
                    options: {
                        responsive: true, maintainAspectRatio: false,
                        plugins: { legend: { display: false } },
                        scales: {
                            x: { grid: { display: false }, ticks: { font: { size: 11 }, color: chartTextColor } },
                            y: { grid: { color: 'rgba(48,54,61,0.5)' }, ticks: { font: { size: 11 }, color: chartTextColor, stepSize: 1 } }
                        },
                        animation: { duration: 800, easing: 'easeOutQuart' }
                    }
                });
            }
        },

        timeAgo(date) {
            const now = new Date();
            const diff = now - date;
            const mins = Math.floor(diff / 60000);
            const hours = Math.floor(diff / 3600000);
            const days = Math.floor(diff / 86400000);

            if (mins < 1) return 'just now';
            if (mins < 60) return `${mins}m ago`;
            if (hours < 24) return `${hours}h ago`;
            if (days < 30) return `${days}d ago`;
            return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        },

        getInitials(name) {
            return name.split(' ').map(w => w[0]).join('').substring(0, 2).toUpperCase();
        },

        getColor(name) {
            const colors = ['#5E6AD2', '#3fb950', '#d29922', '#f85149', '#58a6ff', '#bc8cff', '#db6d28', '#7ee787'];
            const hash = name.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0);
            return colors[hash % colors.length];
        }
    },

    // ========== SOS PANEL ==========
    sos: {
        isOpen: false,
        alertData: [],

        open() {
            const panel = document.getElementById('sos-panel');
            panel.classList.add('active');
            this.isOpen = true;
            document.body.style.overflow = 'hidden';
            this.analyze();
        },

        close() {
            document.getElementById('sos-panel').classList.remove('active');
            this.isOpen = false;
            document.body.style.overflow = '';
        },

        async analyze() {
            const content = document.getElementById('sos-panel-content');
            content.innerHTML = `
                <div class="sos-loading">
                    <div class="loader-spinner"></div>
                    <p>Analyzing tickets...</p>
                </div>
            `;

            const issues = LinearPro.state.issues || [];
            const now = new Date();
            const TWO_DAYS = 2 * 24 * 60 * 60 * 1000;
            const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;

            // Exclude: completed, cancelled, triage, backlog, duplicate
            const excludeTypes = ['completed', 'cancelled', 'triage', 'backlog'];
            const excludeNames = ['triage', 'cancel', 'cancelled', 'duplicate', 'backlog', 'done'];
            const highPriority = issues.filter(i => {
                if (i.priority !== 1 && i.priority !== 2) return false;
                const stateType = (i.state?.type || '').toLowerCase();
                const stateName = (i.state?.name || '').toLowerCase();
                if (excludeTypes.includes(stateType)) return false;
                if (excludeNames.some(n => stateName.includes(n))) return false;
                return true;
            });

            // FAST PRE-FILTER: Only fetch details for tickets not updated in last 2 days
            // Skip tickets updated recently — they're clearly not stale
            const candidates = highPriority.filter(i => {
                const updated = new Date(i.updatedAt);
                const staleMs = now - updated;
                // Must be stale 2+ days AND within 7 day window
                return staleMs >= TWO_DAYS && staleMs <= SEVEN_DAYS;
            });

            const alerts = [];
            const batchSize = 10; // Bigger batches for speed

            if (candidates.length > 0) {
                const loadingP = content.querySelector('.sos-loading p');

                for (let i = 0; i < candidates.length; i += batchSize) {
                    const batch = candidates.slice(i, i + batchSize);
                    if (loadingP) loadingP.textContent = `Checking ${Math.min(i + batchSize, candidates.length)} of ${candidates.length} tickets...`;

                    const details = await Promise.all(
                        batch.map(issue => LinearPro.api.getIssueDetail(issue.id).catch(() => null))
                    );

                    details.forEach((detail, idx) => {
                        if (!detail) return;
                        const issue = batch[idx];
                        const analysis = this.analyzeTicket(detail, now, TWO_DAYS, SEVEN_DAYS);
                        if (analysis) {
                            alerts.push({ issue, detail, ...analysis });
                        }
                    });
                }
            }

            // Sort: severity first, then recent to older within each group
            alerts.sort((a, b) => {
                const sevOrder = { critical: 0, warning: 1 };
                if ((sevOrder[a.severity] ?? 2) !== (sevOrder[b.severity] ?? 2))
                    return (sevOrder[a.severity] ?? 2) - (sevOrder[b.severity] ?? 2);
                return a.staleDays - b.staleDays;
            });

            this.alertData = alerts;
            this.updateNavBadge(alerts.length);
            this.render(alerts);
        },

        analyzeTicket(detail, now, TWO_DAYS, SEVEN_DAYS) {
            // Skip cancelled/done states that slipped through
            const stName = (detail.state?.name || '').toLowerCase();
            const stType = (detail.state?.type || '').toLowerCase();
            if (['cancelled', 'canceled', 'done', 'duplicate'].some(s => stName.includes(s))) return null;
            if (stType === 'completed' || stType === 'cancelled') return null;

            const updatedAt = new Date(detail.updatedAt);
            const timeSinceUpdate = now - updatedAt;

            // Check comments
            const comments = detail.comments?.nodes || [];
            const sortedComments = comments.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
            const lastComment = sortedComments[0];
            const lastCommentDate = lastComment ? new Date(lastComment.createdAt) : null;
            const timeSinceComment = lastCommentDate ? (now - lastCommentDate) : Infinity;

            // Check history
            const history = (detail.history?.nodes || []).filter(h => h.fromState || h.toState);
            const sortedHistory = history.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
            const lastStateChange = sortedHistory[0];
            const lastActivityDate = lastStateChange ? new Date(lastStateChange.createdAt) : null;
            const timeSinceStateChange = lastActivityDate ? (now - lastActivityDate) : Infinity;

            // Last meaningful activity
            const lastMeaningfulActivity = Math.min(timeSinceUpdate, timeSinceComment, timeSinceStateChange);
            const staleDays = Math.floor(lastMeaningfulActivity / (24 * 60 * 60 * 1000));

            // Must be 2-7 days stale
            if (lastMeaningfulActivity < TWO_DAYS || lastMeaningfulActivity > SEVEN_DAYS) return null;

            const reasons = [];
            const isUrgent = detail.priority === 1;
            const FOUR_DAYS = 4 * 24 * 60 * 60 * 1000;

            if (comments.length === 0) {
                reasons.push('No comments or responses');
            } else if (timeSinceComment > TWO_DAYS) {
                reasons.push(`Last comment ${Math.floor(timeSinceComment / (24*60*60*1000))}d ago by ${lastComment?.user?.name || 'unknown'}`);
            }

            if (history.length === 0 || !lastStateChange) {
                reasons.push('No status changes since creation');
            } else if (timeSinceStateChange > TWO_DAYS) {
                const from = lastStateChange.fromState?.name || '—';
                const to = lastStateChange.toState?.name || '—';
                reasons.push(`Status: ${from} → ${to} was ${Math.floor(timeSinceStateChange / (24*60*60*1000))}d ago`);
            }

            // Severity: Urgent = always critical, High + 4d+ = critical, else warning
            let severity = 'warning';
            if (isUrgent || lastMeaningfulActivity >= FOUR_DAYS) severity = 'critical';

            return {
                severity, staleDays, reasons,
                lastCommentDate, lastActivityDate,
                commentCount: comments.length,
                lastCommentAuthor: lastComment?.user?.name || null
            };
        },

        render(alerts) {
            const content = document.getElementById('sos-panel-content');

            const critical = alerts.filter(a => a.severity === 'critical');
            const warning = alerts.filter(a => a.severity === 'warning');

            const totalStale = alerts.length;
            const urgentStale = alerts.filter(a => a.issue.priority === 1).length;
            const avgDays = alerts.length > 0 ? Math.round(alerts.reduce((s, a) => s + a.staleDays, 0) / alerts.length) : 0;
            const noComments = alerts.filter(a => a.commentCount === 0).length;

            if (alerts.length === 0) {
                content.innerHTML = `
                    <div class="sos-header">
                        <div class="sos-icon-box"><i class="fas fa-triangle-exclamation"></i></div>
                        <div class="sos-header-text">
                            <h2>SOS — Critical Alerts</h2>
                            <p>High-priority tickets with no response in 2+ days</p>
                        </div>
                    </div>
                    <div class="sos-subtitle">Analysis based on comments, status changes, and update activity</div>
                    <div class="sos-empty">
                        <div class="sos-empty-icon"><i class="fas fa-check-circle"></i></div>
                        <h3>All Clear!</h3>
                        <p>No high-priority tickets are stale. All urgent and high priority issues have recent activity.</p>
                    </div>
                `;
                return;
            }

            content.innerHTML = `
                <div class="sos-header">
                    <div class="sos-icon-box"><i class="fas fa-triangle-exclamation"></i></div>
                    <div class="sos-header-text">
                        <h2>SOS — Critical Alerts</h2>
                        <p>High-priority tickets with no response in 2+ days</p>
                    </div>
                </div>
                <div class="sos-subtitle">Analysis based on comments, status changes, and update activity across ${LinearPro.state.issues.length} total issues</div>

                <div class="sos-stats">
                    <div class="sos-stat" style="animation-delay:0s">
                        <div class="sos-stat-value" style="color:var(--red)">${totalStale}</div>
                        <div class="sos-stat-label">Stale Tickets</div>
                    </div>
                    <div class="sos-stat" style="animation-delay:0.06s">
                        <div class="sos-stat-value" style="color:var(--orange)">${urgentStale}</div>
                        <div class="sos-stat-label">Urgent Stale</div>
                    </div>
                    <div class="sos-stat" style="animation-delay:0.12s">
                        <div class="sos-stat-value" style="color:var(--yellow)">${avgDays}d</div>
                        <div class="sos-stat-label">Avg Stale Time</div>
                    </div>
                    <div class="sos-stat" style="animation-delay:0.18s">
                        <div class="sos-stat-value" style="color:var(--purple)">${noComments}</div>
                        <div class="sos-stat-label">Zero Comments</div>
                    </div>
                </div>

                ${critical.length > 0 ? `
                <div class="sos-severity-section">
                    <div class="sos-severity-header">
                        <span class="sos-severity-dot" style="background:var(--red)"></span>
                        <span class="sos-severity-title" style="color:var(--red)">Critical</span>
                        <span class="sos-severity-count">${critical.length} tickets</span>
                    </div>
                    <div class="sos-ticket-list">
                        ${critical.map((a, i) => this.renderTicketCard(a, i, 'critical')).join('')}
                    </div>
                </div>
                ` : ''}

                ${warning.length > 0 ? `
                <div class="sos-severity-section">
                    <div class="sos-severity-header">
                        <span class="sos-severity-dot" style="background:var(--orange)"></span>
                        <span class="sos-severity-title" style="color:var(--orange)">Warning</span>
                        <span class="sos-severity-count">${warning.length} tickets</span>
                    </div>
                    <div class="sos-ticket-list">
                        ${warning.map((a, i) => this.renderTicketCard(a, i, 'warning')).join('')}
                    </div>
                </div>
                ` : ''}
            `;

            // Bind ticket clicks
            content.querySelectorAll('.sos-ticket[data-issue-id]').forEach(card => {
                card.addEventListener('click', () => {
                    LinearPro.ticketPanel.open(card.dataset.issueId);
                });
            });
        },

        renderTicketCard(alert, index, severity) {
            const issue = alert.issue;
            const detail = alert.detail;
            const statusColor = issue.state?.color || '#6e7681';
            const statusName = issue.state?.name || 'Unknown';
            const assigneeName = detail.assignee?.displayName || detail.assignee?.name || 'Unassigned';
            const teamName = issue.team?.name || '—';
            const priorityLabel = issue.priorityLabel || 'High';
            const isUrgent = issue.priority === 1;

            const staleBadgeClass = alert.staleDays >= 5 ? 'critical' : alert.staleDays >= 3 ? 'warning' : 'watch';

            return `
                <div class="sos-ticket severity-${severity}" data-issue-id="${issue.id}" style="animation-delay:${index * 0.05}s">
                    <div class="sos-ticket-top">
                        <div style="display:flex;align-items:center;gap:0.5rem">
                            <span class="sos-ticket-id">${detail.identifier || ''}</span>
                            <span class="issue-status-badge" style="background:${statusColor}22;color:${statusColor};font-size:0.68rem;padding:0.15rem 0.45rem">
                                <span class="status-dot" style="background:${statusColor};width:5px;height:5px"></span>
                                ${statusName}
                            </span>
                        </div>
                        <div class="sos-ticket-badges">
                            <span class="sos-stale-badge ${staleBadgeClass}">
                                <i class="fas fa-clock" style="margin-right:0.2rem;font-size:0.6rem"></i>
                                ${alert.staleDays}d stale
                            </span>
                            <span class="issue-priority-badge" style="color:${isUrgent ? 'var(--red)' : 'var(--orange)'};font-size:0.72rem">
                                <i class="fas ${isUrgent ? 'fa-circle-exclamation' : 'fa-arrow-up'}" style="font-size:0.6rem"></i>
                                ${priorityLabel}
                            </span>
                        </div>
                    </div>

                    <div class="sos-ticket-title">${LinearPro.escapeHtml(issue.title)}</div>

                    <div class="sos-ticket-meta">
                        <span class="sos-ticket-meta-item">
                            <i class="fas fa-user" style="color:var(--primary-light)"></i> ${LinearPro.escapeHtml(assigneeName)}
                        </span>
                        <span class="sos-ticket-meta-item">
                            <i class="fas fa-people-group" style="color:var(--blue)"></i> ${LinearPro.escapeHtml(teamName)}
                        </span>
                        <span class="sos-ticket-meta-item">
                            <i class="fas fa-comments" style="color:${alert.commentCount === 0 ? 'var(--red)' : 'var(--text-muted)'}"></i>
                            ${alert.commentCount} comment${alert.commentCount !== 1 ? 's' : ''}
                        </span>
                        <span class="sos-ticket-meta-item">
                            <i class="fas fa-calendar-plus"></i>
                            Created ${LinearPro.modal.timeAgo(new Date(issue.createdAt))}
                        </span>
                    </div>

                    <div class="sos-ticket-reason">
                        <i class="fas fa-magnifying-glass"></i>
                        <span>${alert.reasons.join(' · ')}</span>
                    </div>
                </div>
            `;
        },

        updateNavBadge(count) {
            const badge = document.getElementById('sos-count-badge');
            const btn = document.getElementById('sos-btn');
            if (count > 0) {
                badge.textContent = count;
                badge.style.display = 'inline-flex';
                btn.classList.add('has-alerts');
            } else {
                badge.style.display = 'none';
                btn.classList.remove('has-alerts');
            }
        }
    },

    // ========== DAILY STANDUP PANEL ==========
    standup: {
        isOpen: false,

        open() {
            this.isOpen = true;
            const panel = document.getElementById('standup-panel');
            panel.classList.add('active');
            document.body.style.overflow = 'hidden';
            this.analyze();
        },

        close() {
            this.isOpen = false;
            const panel = document.getElementById('standup-panel');
            panel.classList.remove('active');
            document.body.style.overflow = '';
        },

        analyze() {
            const content = document.getElementById('standup-panel-content');
            content.innerHTML = `
                <div style="display:flex;align-items:center;justify-content:center;padding:3rem">
                    <i class="fas fa-circle-notch fa-spin" style="font-size:1.5rem;color:var(--primary);margin-right:0.75rem"></i>
                    <span style="color:var(--text-secondary)">Analyzing your Linear data...</span>
                </div>
            `;

            // Run analysis on next frame to allow panel animation
            requestAnimationFrame(() => requestAnimationFrame(() => this.runAnalysis()));
        },

        runAnalysis() {
            const { issues, memberData, teams } = LinearPro.state;
            const now = new Date();
            const esc = (t) => LinearPro.escapeHtml(t);

            const ONE_DAY = 24 * 60 * 60 * 1000;
            const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            const threeDaysAgo = new Date(today - 3 * ONE_DAY);
            const sevenDaysAgo = new Date(today - 7 * ONE_DAY);

            // Exclude terminal states for active analysis
            const terminalTypes = ['completed', 'cancelled'];
            const activeIssues = issues.filter(i => !terminalTypes.includes(i.state?.type));
            const completedRecently = issues.filter(i => i.state?.type === 'completed' && i.completedAt && new Date(i.completedAt) >= threeDaysAgo);

            // ---- 1. BLOCKERS: Urgent/High priority stale > 3 days, not completed ----
            const blockers = activeIssues.filter(i => {
                if (i.priority > 2) return false; // Only Urgent (1) and High (2)
                const updated = new Date(i.updatedAt);
                const staleDays = (now - updated) / ONE_DAY;
                return staleDays >= 3;
            }).map(i => {
                const staleDays = Math.floor((now - new Date(i.updatedAt)) / ONE_DAY);
                return { ...i, staleDays, reason: `${staleDays}d since last update — ${i.priorityLabel} priority` };
            }).sort((a, b) => b.staleDays - a.staleDays).slice(0, 15);

            // ---- 2. AT RISK: Medium priority stale > 5 days or any "In Progress" stale > 4 days ----
            const atRisk = activeIssues.filter(i => {
                const updated = new Date(i.updatedAt);
                const staleDays = (now - updated) / ONE_DAY;
                const isInProgress = i.state?.type === 'started';
                const isMediumStale = i.priority === 3 && staleDays >= 5;
                const isProgressStale = isInProgress && staleDays >= 4;
                // Avoid duplicates with blockers
                if (i.priority <= 2 && staleDays >= 3) return false;
                return isMediumStale || isProgressStale;
            }).map(i => {
                const staleDays = Math.floor((now - new Date(i.updatedAt)) / ONE_DAY);
                const isInProgress = i.state?.type === 'started';
                const reason = isInProgress
                    ? `In Progress for ${staleDays}d without update`
                    : `${i.priorityLabel} priority — ${staleDays}d stale`;
                return { ...i, staleDays, reason };
            }).sort((a, b) => b.staleDays - a.staleDays).slice(0, 10);

            // ---- 3. UNASSIGNED high-priority tickets ----
            const unassigned = activeIssues.filter(i => {
                return !i.assignee && i.priority <= 3 && i.priority >= 1;
            }).map(i => {
                const ageDays = Math.floor((now - new Date(i.createdAt)) / ONE_DAY);
                return { ...i, ageDays, reason: `${i.priorityLabel} — unassigned for ${ageDays}d` };
            }).sort((a, b) => a.priority - b.priority || b.ageDays - a.ageDays).slice(0, 10);

            // ---- 4. WORKLOAD IMBALANCES ----
            const activeMembersWithIssues = memberData.filter(m => m.issueCount > 0);
            const avgIssues = activeMembersWithIssues.length > 0
                ? activeMembersWithIssues.reduce((s, m) => s + m.issueCount, 0) / activeMembersWithIssues.length
                : 0;
            const overloaded = activeMembersWithIssues
                .filter(m => m.issueCount > avgIssues * 1.6 && m.issueCount >= 5)
                .sort((a, b) => b.issueCount - a.issueCount);
            const underloaded = memberData
                .filter(m => m.issueCount === 0 || (m.issueCount < avgIssues * 0.3 && avgIssues > 3))
                .sort((a, b) => a.issueCount - b.issueCount);

            // ---- 5. RECENTLY COMPLETED (last 3 days) — progress check ----
            const completedByTeam = {};
            completedRecently.forEach(i => {
                const team = i.team?.name || 'Other';
                completedByTeam[team] = (completedByTeam[team] || 0) + 1;
            });

            // ---- 6. NEW ISSUES created today/yesterday ----
            const yesterday = new Date(today - ONE_DAY);
            const newIssues = issues.filter(i => new Date(i.createdAt) >= yesterday)
                .sort((a, b) => a.priority - b.priority || new Date(b.createdAt) - new Date(a.createdAt))
                .slice(0, 10);

            // ---- 7. OVERALL STATS ----
            const totalActive = activeIssues.length;
            const totalInProgress = activeIssues.filter(i => i.state?.type === 'started').length;
            const totalBlocked = blockers.length;
            const completedToday = issues.filter(i => i.state?.type === 'completed' && i.completedAt && new Date(i.completedAt) >= today).length;

            // ---- RENDER ----
            this.render({
                blockers, atRisk, unassigned, overloaded, underloaded,
                completedRecently, completedByTeam, newIssues,
                totalActive, totalInProgress, totalBlocked, completedToday,
                avgIssues, memberData
            });
        },

        render(data) {
            const content = document.getElementById('standup-panel-content');
            const esc = (t) => LinearPro.escapeHtml(t);
            const now = new Date();
            const dateStr = now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

            const {
                blockers, atRisk, unassigned, overloaded, underloaded,
                completedRecently, completedByTeam, newIssues,
                totalActive, totalInProgress, totalBlocked, completedToday,
                avgIssues
            } = data;

            content.innerHTML = `
                <div class="standup-header">
                    <h2><i class="fas fa-clipboard-list"></i> Daily Standup Brief</h2>
                    <div class="standup-date"><i class="fas fa-calendar-day"></i> ${esc(dateStr)}</div>
                </div>

                <!-- Progress Overview -->
                <div class="standup-section progress">
                    <div class="standup-section-header">
                        <div class="standup-section-icon"><i class="fas fa-chart-line"></i></div>
                        <h3>Snapshot</h3>
                    </div>
                    <div class="standup-progress-grid">
                        <div class="standup-progress-stat" style="animation-delay:0s">
                            <div class="stat-value" style="color:var(--primary-light)">${totalActive}</div>
                            <div class="stat-label">Active Issues</div>
                        </div>
                        <div class="standup-progress-stat" style="animation-delay:0.05s">
                            <div class="stat-value" style="color:var(--yellow)">${totalInProgress}</div>
                            <div class="stat-label">In Progress</div>
                        </div>
                        <div class="standup-progress-stat" style="animation-delay:0.1s">
                            <div class="stat-value" style="color:var(--green)">${completedToday}</div>
                            <div class="stat-label">Completed Today</div>
                        </div>
                        <div class="standup-progress-stat" style="animation-delay:0.15s">
                            <div class="stat-value" style="color:var(--green)">${completedRecently.length}</div>
                            <div class="stat-label">Completed (3d)</div>
                        </div>
                        <div class="standup-progress-stat" style="animation-delay:0.2s">
                            <div class="stat-value" style="color:var(--red)">${totalBlocked}</div>
                            <div class="stat-label">Blocked / Stale</div>
                        </div>
                        <div class="standup-progress-stat" style="animation-delay:0.25s">
                            <div class="stat-value" style="color:var(--orange)">${unassigned.length}</div>
                            <div class="stat-label">Unassigned (P1-P3)</div>
                        </div>
                    </div>
                </div>

                <!-- Blockers -->
                ${blockers.length > 0 ? `
                <div class="standup-section blockers">
                    <div class="standup-section-header">
                        <div class="standup-section-icon"><i class="fas fa-hand"></i></div>
                        <h3>Blockers &amp; Stale High Priority</h3>
                        <span class="standup-section-count">${blockers.length}</span>
                    </div>
                    ${blockers.map((i, idx) => this.renderItem(i, idx, i.reason)).join('')}
                </div>` : `
                <div class="standup-section blockers">
                    <div class="standup-section-header">
                        <div class="standup-section-icon"><i class="fas fa-hand"></i></div>
                        <h3>Blockers &amp; Stale High Priority</h3>
                    </div>
                    <div class="standup-empty"><i class="fas fa-check" style="color:var(--green);margin-right:0.3rem"></i> No blockers — all high priority tickets are active.</div>
                </div>`}

                <!-- At Risk -->
                ${atRisk.length > 0 ? `
                <div class="standup-section at-risk">
                    <div class="standup-section-header">
                        <div class="standup-section-icon"><i class="fas fa-exclamation-circle"></i></div>
                        <h3>At Risk</h3>
                        <span class="standup-section-count">${atRisk.length}</span>
                    </div>
                    ${atRisk.map((i, idx) => this.renderItem(i, idx, i.reason)).join('')}
                </div>` : ''}

                <!-- Unassigned -->
                ${unassigned.length > 0 ? `
                <div class="standup-section unassigned">
                    <div class="standup-section-header">
                        <div class="standup-section-icon"><i class="fas fa-user-slash"></i></div>
                        <h3>Unassigned Tickets (Need Owner)</h3>
                        <span class="standup-section-count">${unassigned.length}</span>
                    </div>
                    ${unassigned.map((i, idx) => this.renderItem(i, idx, i.reason)).join('')}
                </div>` : ''}

                <!-- Workload Imbalances -->
                ${overloaded.length > 0 || underloaded.length > 0 ? `
                <div class="standup-section workload">
                    <div class="standup-section-header">
                        <div class="standup-section-icon"><i class="fas fa-scale-unbalanced"></i></div>
                        <h3>Workload Alerts</h3>
                    </div>
                    <p style="font-size:0.78rem;color:var(--text-secondary);margin-bottom:0.65rem">
                        Average workload: <strong style="color:var(--text-primary)">${avgIssues.toFixed(1)}</strong> issues/person
                    </p>
                    ${overloaded.map((m, idx) => this.renderWorkloadCard(m, 'over', avgIssues, idx)).join('')}
                    ${underloaded.map((m, idx) => this.renderWorkloadCard(m, 'under', avgIssues, idx + overloaded.length)).join('')}
                </div>` : ''}

                <!-- New Issues -->
                ${newIssues.length > 0 ? `
                <div class="standup-section new-items">
                    <div class="standup-section-header">
                        <div class="standup-section-icon"><i class="fas fa-plus-circle"></i></div>
                        <h3>New Issues (Last 24h)</h3>
                        <span class="standup-section-count">${newIssues.length}</span>
                    </div>
                    ${newIssues.map((i, idx) => this.renderItem(i, idx, `Created ${LinearPro.modal.timeAgo(new Date(i.createdAt))}`)).join('')}
                </div>` : ''}

                <!-- Team Completion Summary -->
                ${completedRecently.length > 0 ? `
                <div class="standup-section progress">
                    <div class="standup-section-header">
                        <div class="standup-section-icon"><i class="fas fa-trophy"></i></div>
                        <h3>Completed (Last 3 Days)</h3>
                        <span class="standup-section-count">${completedRecently.length}</span>
                    </div>
                    <div class="standup-progress-grid">
                        ${Object.entries(data.completedByTeam).sort((a, b) => b[1] - a[1]).map(([team, count], idx) => `
                            <div class="standup-progress-stat" style="animation-delay:${idx * 0.05}s">
                                <div class="stat-value" style="color:var(--green)">${count}</div>
                                <div class="stat-label">${esc(team)}</div>
                            </div>
                        `).join('')}
                    </div>
                </div>` : ''}
            `;

            // Bind click events for issue items
            content.querySelectorAll('.standup-item[data-issue-id]').forEach(el => {
                el.addEventListener('click', () => {
                    LinearPro.ticketPanel.open(el.dataset.issueId);
                });
            });
        },

        renderItem(issue, index, reason) {
            const esc = (t) => LinearPro.escapeHtml(t);
            const statusColor = issue.state?.color || '#6e7681';
            const statusName = issue.state?.name || 'Unknown';
            const assigneeName = issue.assignee?.name || 'Unassigned';
            const teamName = issue.team?.name || '—';
            const pLabel = issue.priorityLabel || 'No Priority';
            const priorityColors = { 'Urgent': 'var(--red)', 'High': 'var(--orange)', 'Medium': 'var(--yellow)', 'Low': 'var(--blue)', 'No Priority': 'var(--text-muted)' };
            const pColor = priorityColors[pLabel] || 'var(--text-muted)';

            return `
                <div class="standup-item" data-issue-id="${issue.id}" style="animation-delay:${index * 0.04}s">
                    <div class="standup-item-top">
                        <span class="standup-item-id">${esc(issue.identifier || '')}</span>
                        <span class="issue-status-badge" style="background:${statusColor}22;color:${statusColor};font-size:0.68rem;padding:0.12rem 0.4rem">
                            <span class="status-dot" style="background:${statusColor};width:5px;height:5px"></span>
                            ${esc(statusName)}
                        </span>
                        <span class="issue-priority-badge" style="color:${pColor};font-size:0.68rem">
                            <i class="fas fa-circle" style="font-size:0.35rem"></i> ${esc(pLabel)}
                        </span>
                    </div>
                    <div class="standup-item-title">${esc(issue.title)}</div>
                    <div class="standup-item-meta">
                        <span><i class="fas fa-user" style="color:var(--primary-light)"></i> ${esc(assigneeName)}</span>
                        <span><i class="fas fa-people-group" style="color:var(--blue)"></i> ${esc(teamName)}</span>
                    </div>
                    ${reason ? `<div class="standup-item-reason"><i class="fas fa-info-circle"></i> ${esc(reason)}</div>` : ''}
                </div>
            `;
        },

        renderWorkloadCard(member, type, avgIssues, index) {
            const esc = (t) => LinearPro.escapeHtml(t);
            const name = member.displayName || member.name;
            const initials = name.split(' ').map(w => w[0]).join('').substring(0, 2).toUpperCase();
            const colors = ['#5E6AD2', '#3fb950', '#d29922', '#f85149', '#58a6ff', '#bc8cff', '#db6d28', '#7ee787'];
            const hash = name.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0);
            const color = colors[hash % colors.length];

            const maxForBar = Math.max(...LinearPro.state.memberData.map(m => m.issueCount), 1);
            const pct = (member.issueCount / maxForBar * 100).toFixed(0);
            const barColor = type === 'over' ? 'var(--red)' : 'var(--yellow)';
            const label = type === 'over'
                ? `${member.issueCount} issues — ${(member.issueCount / avgIssues * 100 - 100).toFixed(0)}% above average`
                : member.issueCount === 0 ? 'No issues assigned' : `${member.issueCount} issues — well below average`;

            return `
                <div class="standup-workload-card" style="animation-delay:${index * 0.04}s">
                    <div class="standup-workload-avatar" style="background:${color}">${esc(initials)}</div>
                    <div class="standup-workload-info">
                        <div class="standup-workload-name">${esc(name)}</div>
                        <div class="standup-workload-detail">${esc(label)}</div>
                    </div>
                    <div class="standup-workload-bar">
                        <div class="standup-workload-bar-fill" style="width:${pct}%;background:${barColor}"></div>
                    </div>
                </div>
            `;
        }
    },

    // ========== TICKET DETAIL PANEL ==========
    ticketPanel: {
        isOpen: false,

        async open(issueId) {
            const panel = document.getElementById('ticket-panel');
            const content = document.getElementById('ticket-panel-content');

            // Show loading state
            content.innerHTML = `
                <div class="ticket-loading">
                    <div class="loader-spinner"></div>
                    <p>Loading ticket details...</p>
                </div>
            `;

            panel.classList.add('active');
            this.isOpen = true;

            try {
                const issue = await LinearPro.api.getIssueDetail(issueId);
                this.render(issue);
            } catch (err) {
                content.innerHTML = `
                    <div class="ticket-loading">
                        <i class="fas fa-exclamation-triangle" style="font-size:1.5rem;color:var(--red)"></i>
                        <p>Failed to load ticket: ${err.message}</p>
                    </div>
                `;
            }
        },

        close() {
            document.getElementById('ticket-panel').classList.remove('active');
            this.isOpen = false;
            // Only restore scroll if no other panel is open behind
            if (!LinearPro.modal.currentMember && !LinearPro.sos.isOpen) {
                document.body.style.overflow = '';
            }
        },

        render(issue) {
            const content = document.getElementById('ticket-panel-content');

            const priorityColors = {
                'Urgent': 'var(--red)', 'High': 'var(--orange)',
                'Medium': 'var(--yellow)', 'Low': 'var(--blue)', 'No Priority': 'var(--text-muted)'
            };
            const priorityIcons = {
                'Urgent': 'fa-circle-exclamation', 'High': 'fa-arrow-up',
                'Medium': 'fa-minus', 'Low': 'fa-arrow-down', 'No Priority': 'fa-circle'
            };

            const pLabel = issue.priorityLabel || 'No Priority';
            const pColor = priorityColors[pLabel] || 'var(--text-muted)';
            const pIcon = priorityIcons[pLabel] || 'fa-circle';
            const statusColor = issue.state?.color || '#6e7681';
            const statusName = issue.state?.name || 'Unknown';
            const assigneeName = issue.assignee?.displayName || issue.assignee?.name || 'Unassigned';
            const teamName = issue.team?.name || '—';

            const created = issue.createdAt ? new Date(issue.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
            const updated = issue.updatedAt ? LinearPro.modal.timeAgo(new Date(issue.updatedAt)) : '—';
            const completed = issue.completedAt ? new Date(issue.completedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : null;

            // Labels HTML
            const labelsHTML = issue.labels?.nodes?.length > 0
                ? issue.labels.nodes.map(l => `<span class="ticket-label" style="color:${l.color};border-color:${l.color}33;background:${l.color}12">${LinearPro.escapeHtml(l.name)}</span>`).join('')
                : '';

            // Comments HTML
            const comments = issue.comments?.nodes || [];
            const commentsHTML = comments.length > 0
                ? comments.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt)).map(c => {
                    const authorName = c.user?.displayName || c.user?.name || 'Unknown';
                    const initials = authorName.split(' ').map(w => w[0]).join('').substring(0, 2).toUpperCase();
                    const avatarColor = LinearPro.modal.getColor(authorName);
                    const commentDate = LinearPro.modal.timeAgo(new Date(c.createdAt));
                    return `
                        <div class="ticket-comment">
                            <div class="ticket-comment-header">
                                <span class="ticket-comment-author">
                                    <span class="ticket-comment-author-avatar" style="background:${avatarColor}">${LinearPro.escapeHtml(initials)}</span>
                                    ${LinearPro.escapeHtml(authorName)}
                                </span>
                                <span class="ticket-comment-date">${commentDate}</span>
                            </div>
                            <div class="ticket-comment-body">${this.escapeHtml(c.body || '')}</div>
                        </div>
                    `;
                }).join('')
                : '<div class="ticket-no-comments"><i class="fas fa-comment-slash" style="margin-right:0.4rem;opacity:0.5"></i>No comments yet</div>';

            // History / Activity timeline
            const history = (issue.history?.nodes || []).filter(h => h.fromState || h.toState);
            const timelineHTML = history.length > 0
                ? history.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 10).map(h => {
                    const date = LinearPro.modal.timeAgo(new Date(h.createdAt));
                    const from = h.fromState?.name || '—';
                    const to = h.toState?.name || '—';
                    const toColor = h.toState?.color || '#6e7681';
                    const actor = h.actor?.name || 'System';
                    return `
                        <div class="timeline-item">
                            <div class="timeline-date">${date}</div>
                            <div class="timeline-text">
                                <strong>${actor}</strong> moved from <span style="color:${h.fromState?.color || 'var(--text-muted)'}">${from}</span>
                                → <span style="color:${toColor};font-weight:600">${to}</span>
                            </div>
                        </div>
                    `;
                }).join('')
                : '<div class="ticket-no-comments">No status changes recorded</div>';

            // Sub-issues HTML
            const children = issue.children?.nodes || [];
            const subIssuesHTML = children.length > 0
                ? `<div class="ticket-section">
                    <div class="ticket-section-title"><i class="fas fa-sitemap"></i> Sub-Issues (${children.length})</div>
                    <div class="ticket-comments-list">
                        ${children.map(c => {
                            const sColor = c.state?.color || '#6e7681';
                            const sName = c.state?.name || 'Unknown';
                            const isDone = c.state?.type === 'completed';
                            return `
                                <div class="ticket-comment" style="padding:0.7rem 1rem;cursor:pointer" data-sub-issue-id="${c.id}">
                                    <div style="display:flex;align-items:center;gap:0.5rem">
                                        <span class="issue-status-badge" style="background:${sColor}22;color:${sColor};font-size:0.68rem;padding:0.15rem 0.45rem">
                                            <span class="status-dot" style="background:${sColor};width:5px;height:5px"></span>
                                            ${LinearPro.escapeHtml(sName)}
                                        </span>
                                        <span style="font-size:0.72rem;color:var(--primary-light);font-weight:600">${LinearPro.escapeHtml(c.identifier)}</span>
                                        <span style="font-size:0.82rem;${isDone ? 'text-decoration:line-through;color:var(--text-muted)' : ''}">${LinearPro.escapeHtml(c.title)}</span>
                                    </div>
                                </div>
                            `;
                        }).join('')}
                    </div>
                </div>`
                : '';

            // Parent issue
            const parentHTML = issue.parent
                ? `<div class="ticket-meta-item">
                    <span class="ticket-meta-label">Parent Issue</span>
                    <span class="ticket-meta-value" style="cursor:pointer;color:var(--primary-light)" data-parent-issue-id="${issue.parent.id}">
                        <i class="fas fa-level-up-alt" style="font-size:0.7rem"></i>
                        ${LinearPro.escapeHtml(issue.parent.identifier)} — ${LinearPro.escapeHtml(issue.parent.title)}
                    </span>
                </div>`
                : '';

            content.innerHTML = `
                <div class="ticket-header">
                    <div class="ticket-id-row">
                        <span class="ticket-identifier">${issue.identifier || ''}</span>
                        <span class="issue-status-badge" style="background:${statusColor}22;color:${statusColor}">
                            <span class="status-dot" style="background:${statusColor}"></span>
                            ${statusName}
                        </span>
                        <span class="issue-priority-badge" style="color:${pColor}">
                            <i class="fas ${pIcon} priority-icon"></i>
                            ${pLabel}
                        </span>
                    </div>
                    <h2 class="ticket-title">${LinearPro.escapeHtml(issue.title)}</h2>
                    ${labelsHTML ? `<div class="ticket-labels">${labelsHTML}</div>` : ''}
                </div>

                <!-- Meta Grid -->
                <div class="ticket-meta">
                    <div class="ticket-meta-item">
                        <span class="ticket-meta-label">Assignee</span>
                        <span class="ticket-meta-value">
                            <i class="fas fa-user" style="font-size:0.7rem;color:var(--primary-light)"></i>
                            ${LinearPro.escapeHtml(assigneeName)}
                        </span>
                    </div>
                    <div class="ticket-meta-item">
                        <span class="ticket-meta-label">Team</span>
                        <span class="ticket-meta-value">
                            <i class="fas fa-people-group" style="font-size:0.7rem;color:var(--blue)"></i>
                            ${LinearPro.escapeHtml(teamName)}
                        </span>
                    </div>
                    <div class="ticket-meta-item">
                        <span class="ticket-meta-label">Created</span>
                        <span class="ticket-meta-value">${created}</span>
                    </div>
                    <div class="ticket-meta-item">
                        <span class="ticket-meta-label">Updated</span>
                        <span class="ticket-meta-value">${updated}</span>
                    </div>
                    ${completed ? `
                    <div class="ticket-meta-item">
                        <span class="ticket-meta-label">Completed</span>
                        <span class="ticket-meta-value" style="color:var(--green)"><i class="fas fa-check-circle" style="font-size:0.7rem"></i> ${completed}</span>
                    </div>` : ''}
                    ${issue.project ? `
                    <div class="ticket-meta-item">
                        <span class="ticket-meta-label">Project</span>
                        <span class="ticket-meta-value"><i class="fas fa-folder" style="font-size:0.7rem;color:var(--purple)"></i> ${LinearPro.escapeHtml(issue.project.name)}</span>
                    </div>` : ''}
                    ${issue.cycle ? `
                    <div class="ticket-meta-item">
                        <span class="ticket-meta-label">Cycle</span>
                        <span class="ticket-meta-value"><i class="fas fa-arrows-rotate" style="font-size:0.7rem;color:var(--yellow)"></i> ${LinearPro.escapeHtml(issue.cycle.name || 'Cycle ' + issue.cycle.number)}</span>
                    </div>` : ''}
                    ${issue.estimate != null ? `
                    <div class="ticket-meta-item">
                        <span class="ticket-meta-label">Estimate</span>
                        <span class="ticket-meta-value"><i class="fas fa-gauge" style="font-size:0.7rem;color:var(--orange)"></i> ${issue.estimate} pts</span>
                    </div>` : ''}
                    ${parentHTML}
                </div>

                <!-- Description -->
                <div class="ticket-section">
                    <div class="ticket-section-title"><i class="fas fa-align-left"></i> Description</div>
                    ${issue.description
                        ? `<div class="ticket-description">${this.escapeHtml(issue.description)}</div>`
                        : `<div class="ticket-description-empty">No description provided</div>`}
                </div>

                ${subIssuesHTML}

                <!-- Comments -->
                <div class="ticket-section">
                    <div class="ticket-section-title"><i class="fas fa-comments"></i> Comments (${comments.length})</div>
                    <div class="ticket-comments-list">${commentsHTML}</div>
                </div>

                <!-- Activity -->
                <div class="ticket-section">
                    <div class="ticket-section-title"><i class="fas fa-clock-rotate-left"></i> Activity</div>
                    <div class="ticket-timeline">${timelineHTML}</div>
                </div>
            `;

            // Event delegation for sub-issues and parent issue clicks
            content.querySelectorAll('[data-sub-issue-id]').forEach(el => {
                el.addEventListener('click', () => LinearPro.ticketPanel.open(el.dataset.subIssueId));
            });
            content.querySelectorAll('[data-parent-issue-id]').forEach(el => {
                el.addEventListener('click', () => LinearPro.ticketPanel.open(el.dataset.parentIssueId));
            });
        },

        escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }
    },

    // ========== CHARTS ==========
    renderCharts() {
        // Destroy existing
        Object.values(this.charts).forEach(c => c?.destroy());

        const chartTextColor = '#8b949e';
        const chartGridColor = 'rgba(48, 54, 61, 0.5)';

        Chart.defaults.color = chartTextColor;
        Chart.defaults.font.family = 'Inter';

        // 1. Status Distribution (Doughnut)
        const statusLabels = Object.keys(this.state.globalStatusDist);
        const statusData = Object.values(this.state.globalStatusDist);
        const statusColors = statusLabels.map(l => this.state.statusColorMap[l] || '#6e7681');

        this.charts.status = new Chart(document.getElementById('chart-status'), {
            type: 'doughnut',
            data: {
                labels: statusLabels,
                datasets: [{
                    data: statusData,
                    backgroundColor: statusColors,
                    borderWidth: 0,
                    hoverOffset: 8
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                cutout: '62%',
                plugins: {
                    legend: {
                        position: 'right',
                        labels: {
                            padding: 12,
                            usePointStyle: true,
                            pointStyleWidth: 10,
                            font: { size: 11 }
                        }
                    }
                },
                animation: {
                    animateRotate: true,
                    duration: 1500
                }
            }
        });

        // 2. Workload Chart (Horizontal Bar)
        const sorted = [...this.state.memberData]
            .filter(m => m.issueCount > 0)
            .sort((a, b) => b.issueCount - a.issueCount)
            .slice(0, 15);

        const workloadLabels = sorted.map(m => m.displayName || m.name);
        const workloadData = sorted.map(m => m.issueCount);

        // Gradient colors based on workload
        const maxIssues = Math.max(...workloadData, 1);
        const barColors = workloadData.map(d => {
            const ratio = d / maxIssues;
            if (ratio > 0.8) return '#f85149';
            if (ratio > 0.5) return '#d29922';
            return '#5E6AD2';
        });

        this.charts.workload = new Chart(document.getElementById('chart-workload'), {
            type: 'bar',
            data: {
                labels: workloadLabels,
                datasets: [{
                    label: 'Assigned Issues',
                    data: workloadData,
                    backgroundColor: barColors,
                    borderRadius: 4,
                    borderSkipped: false
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                indexAxis: 'y',
                plugins: {
                    legend: { display: false }
                },
                scales: {
                    x: {
                        grid: { color: chartGridColor },
                        ticks: { font: { size: 11 } }
                    },
                    y: {
                        grid: { display: false },
                        ticks: { font: { size: 11 } }
                    }
                },
                animation: {
                    duration: 1200,
                    easing: 'easeOutQuart'
                }
            }
        });

        // 3. Priority Breakdown (Polar Area)
        const priorityOrder = ['Urgent', 'High', 'Medium', 'Low', 'No Priority'];
        const priorityColors = {
            'Urgent': '#f85149',
            'High': '#db6d28',
            'Medium': '#d29922',
            'Low': '#58a6ff',
            'No Priority': '#6e7681'
        };

        const pLabels = priorityOrder.filter(p => this.state.priorityDist[p]);
        const pData = pLabels.map(p => this.state.priorityDist[p]);
        const pColors = pLabels.map(p => priorityColors[p] || '#6e7681');

        this.charts.priority = new Chart(document.getElementById('chart-priority'), {
            type: 'polarArea',
            data: {
                labels: pLabels,
                datasets: [{
                    data: pData,
                    backgroundColor: pColors.map(c => c + '99'),
                    borderColor: pColors,
                    borderWidth: 1
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        position: 'right',
                        labels: {
                            padding: 12,
                            usePointStyle: true,
                            pointStyleWidth: 10,
                            font: { size: 11 }
                        }
                    }
                },
                scales: {
                    r: {
                        grid: { color: chartGridColor },
                        ticks: { display: false }
                    }
                },
                animation: { duration: 1200 }
            }
        });

        // 4. Issues by Team (Bar)
        const teamLabels = Object.keys(this.state.teamDist);
        const teamData = Object.values(this.state.teamDist);
        const teamColors = teamLabels.map((_, i) => {
            const palette = ['#5E6AD2', '#58a6ff', '#bc8cff', '#3fb950', '#d29922', '#f85149', '#db6d28', '#7ee787'];
            return palette[i % palette.length];
        });

        this.charts.teams = new Chart(document.getElementById('chart-teams'), {
            type: 'bar',
            data: {
                labels: teamLabels,
                datasets: [{
                    label: 'Issues',
                    data: teamData,
                    backgroundColor: teamColors,
                    borderRadius: 6,
                    borderSkipped: false
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false }
                },
                scales: {
                    x: {
                        grid: { display: false },
                        ticks: { font: { size: 11 } }
                    },
                    y: {
                        grid: { color: chartGridColor },
                        ticks: { font: { size: 11 } }
                    }
                },
                animation: {
                    duration: 1200,
                    easing: 'easeOutQuart'
                }
            }
        });
    },

    // ========== PARTICLES BACKGROUND ==========
    initParticles() {
        const canvas = document.getElementById('particles-canvas');
        const ctx = canvas.getContext('2d');
        let particles = [];
        let mouse = { x: null, y: null };
        const PARTICLE_COUNT = 80;
        const CONNECTION_DISTANCE = 150;

        function resize() {
            canvas.width = window.innerWidth;
            canvas.height = window.innerHeight;
        }
        resize();
        window.addEventListener('resize', resize);

        document.addEventListener('mousemove', (e) => {
            mouse.x = e.clientX;
            mouse.y = e.clientY;
        });

        class Particle {
            constructor() {
                this.x = Math.random() * canvas.width;
                this.y = Math.random() * canvas.height;
                this.vx = (Math.random() - 0.5) * 0.5;
                this.vy = (Math.random() - 0.5) * 0.5;
                this.radius = Math.random() * 2 + 1;
                this.opacity = Math.random() * 0.5 + 0.1;
            }

            update() {
                this.x += this.vx;
                this.y += this.vy;

                if (this.x < 0 || this.x > canvas.width) this.vx *= -1;
                if (this.y < 0 || this.y > canvas.height) this.vy *= -1;

                // Mouse interaction
                if (mouse.x !== null) {
                    const dx = mouse.x - this.x;
                    const dy = mouse.y - this.y;
                    const dist = Math.sqrt(dx * dx + dy * dy);
                    if (dist < 200) {
                        const force = (200 - dist) / 200 * 0.02;
                        this.vx += dx * force;
                        this.vy += dy * force;
                    }
                }

                // Damping
                this.vx *= 0.99;
                this.vy *= 0.99;
            }

            draw() {
                ctx.beginPath();
                ctx.arc(this.x, this.y, this.radius, 0, Math.PI * 2);
                ctx.fillStyle = `rgba(94, 106, 210, ${this.opacity})`;
                ctx.fill();
            }
        }

        for (let i = 0; i < PARTICLE_COUNT; i++) {
            particles.push(new Particle());
        }

        function animate() {
            ctx.clearRect(0, 0, canvas.width, canvas.height);

            particles.forEach(p => {
                p.update();
                p.draw();
            });

            // Draw connections
            for (let i = 0; i < particles.length; i++) {
                for (let j = i + 1; j < particles.length; j++) {
                    const dx = particles[i].x - particles[j].x;
                    const dy = particles[i].y - particles[j].y;
                    const dist = Math.sqrt(dx * dx + dy * dy);

                    if (dist < CONNECTION_DISTANCE) {
                        const opacity = (1 - dist / CONNECTION_DISTANCE) * 0.15;
                        ctx.beginPath();
                        ctx.moveTo(particles[i].x, particles[i].y);
                        ctx.lineTo(particles[j].x, particles[j].y);
                        ctx.strokeStyle = `rgba(94, 106, 210, ${opacity})`;
                        ctx.lineWidth = 0.5;
                        ctx.stroke();
                    }
                }
            }

            requestAnimationFrame(animate);
        }

        animate();
    },

    // ========== DATA LOADING ==========
    async loadAllData() {
        this.ui.showLoading(true);

        try {
            this.ui.updateLoadingText('Fetching teams and workflow states...');
            await Promise.all([
                this.api.getTeams(),
                this.api.getWorkflowStates()
            ]);

            this.ui.updateLoadingText('Fetching team members...');
            await this.api.getUsers();

            this.ui.updateLoadingText('Fetching issues...');
            await this.api.getIssues();

            this.ui.updateLoadingText('Processing data...');
            this.processData();

            this.ui.showLoading(false);
            this.ui.renderDashboard();
            this.ui.toast('Data loaded successfully!', 'success');

        } catch (err) {
            this.ui.showLoading(false);
            this.ui.toast(`Error: ${err.message}`, 'error');
            console.error('Data loading error:', err);
        }
    },

    // ========== EVENT HANDLERS ==========
    bindEvents() {
        // Toggle API key visibility
        document.getElementById('toggle-visibility').addEventListener('click', () => {
            const input = document.getElementById('api-key-input');
            const icon = document.querySelector('#toggle-visibility i');
            if (input.type === 'password') {
                input.type = 'text';
                icon.className = 'fas fa-eye-slash';
            } else {
                input.type = 'password';
                icon.className = 'fas fa-eye';
            }
        });

        // Connect button
        document.getElementById('connect-btn').addEventListener('click', async () => {
            const btn = document.getElementById('connect-btn');
            const input = document.getElementById('api-key-input');
            const key = input.value.trim();

            if (!key) {
                this.ui.showLoginError('Please enter your Linear API key.');
                return;
            }

            btn.classList.add('loading');
            this.ui.hideLoginError();

            try {
                this.state.apiKey = key;
                await this.api.testConnection();
                localStorage.setItem('linearApiKey', key);
                await this.loadAllData();
            } catch (err) {
                this.state.apiKey = null;
                this.ui.showLoginError(`Connection failed: ${err.message}`);
            } finally {
                btn.classList.remove('loading');
            }
        });

        // Enter key on input
        document.getElementById('api-key-input').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                document.getElementById('connect-btn').click();
            }
        });

        // Refresh
        document.getElementById('refresh-btn').addEventListener('click', async () => {
            const btn = document.getElementById('refresh-btn');
            btn.classList.add('refreshing');
            await this.loadAllData();
            btn.classList.remove('refreshing');
        });

        // Disconnect
        document.getElementById('disconnect-btn').addEventListener('click', () => {
            localStorage.removeItem('linearApiKey');
            this.state.apiKey = null;
            this.state.users = [];
            this.state.issues = [];
            this.state.memberData = [];
            document.getElementById('api-key-input').value = '';
            this.ui.showView('login-view');
            this.ui.toast('Disconnected from Linear', 'info');
        });

        // Modal close button
        document.getElementById('modal-close').addEventListener('click', () => {
            this.modal.close();
        });

        // Modal backdrop click to close
        document.querySelector('.modal-backdrop').addEventListener('click', () => {
            this.modal.close();
        });

        // Standup button
        document.getElementById('standup-btn').addEventListener('click', () => {
            this.standup.open();
        });

        // Standup panel close
        document.getElementById('standup-panel-close').addEventListener('click', () => {
            this.standup.close();
        });

        document.querySelector('.standup-panel-backdrop').addEventListener('click', () => {
            this.standup.close();
        });

        // SOS button
        document.getElementById('sos-btn').addEventListener('click', () => {
            this.sos.open();
        });

        // SOS panel close
        document.getElementById('sos-panel-close').addEventListener('click', () => {
            this.sos.close();
        });

        document.querySelector('.sos-panel-backdrop').addEventListener('click', () => {
            this.sos.close();
        });

        // Ticket panel close
        document.getElementById('ticket-panel-close').addEventListener('click', () => {
            this.ticketPanel.close();
        });

        document.querySelector('.ticket-panel-backdrop').addEventListener('click', () => {
            this.ticketPanel.close();
        });

        // Escape key to close (deepest panel first)
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                if (this.ticketPanel.isOpen) {
                    this.ticketPanel.close();
                } else if (this.sos.isOpen) {
                    this.sos.close();
                } else if (this.standup.isOpen) {
                    this.standup.close();
                } else {
                    this.modal.close();
                }
            }
        });

        // Sort buttons
        document.querySelectorAll('.sort-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.sort-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                this.state.sortBy = btn.dataset.sort;
                this.ui.renderMemberCards();
            });
        });
    },

    // ========== INIT ==========
    init() {
        this.initParticles();
        this.bindEvents();

        // Check for saved API key
        const savedKey = localStorage.getItem('linearApiKey');
        if (savedKey) {
            this.state.apiKey = savedKey;
            document.getElementById('api-key-input').value = savedKey;
            // Auto-connect
            this.api.testConnection()
                .then(() => this.loadAllData())
                .catch(() => {
                    localStorage.removeItem('linearApiKey');
                    this.ui.showView('login-view');
                });
        } else {
            this.ui.showView('login-view');
        }
    }
};

// Boot
document.addEventListener('DOMContentLoaded', () => LinearPro.init());
