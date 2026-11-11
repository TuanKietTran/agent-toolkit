//! The console's preview view: a planned team drawn with the live graph's widgets, every node
//! dim (`planned`), warnings in red, a side panel for the selected node and a diff against the
//! running labs. Loading is read-only: a `.json` preview is read, anything else is turned into
//! one by running `h1 preview FILE` (`$H1_BIN`, else this executable). It never opens,
//! stops or writes anything.

use super::*;
use crate::preview::{self, Preview, Severity};

/// A loaded preview plus the pre-arranged planned labs and the overlay that makes the graph
/// widgets draw its manifest-style lines.
pub(super) struct PreviewState {
    pub doc: Preview,
    pub labs: Vec<Lab>,
    pub overlay: crate::graphspec::Overlay,
    pub selected: Option<String>,
}

/// Preview vs the live labs.
#[derive(Debug, Default, PartialEq, Eq)]
pub(super) struct Diff {
    pub will_start: Vec<String>,
    pub already_running: Vec<String>,
    pub would_stop: Vec<String>,
}

/// Read a preview from `arg`: a `.json` file directly, otherwise through `h1 preview`.
pub(super) fn load_source(arg: &str) -> Result<Preview, String> {
    if arg.ends_with(".json") {
        return preview::load(Path::new(arg));
    }
    let program = env::var("H1_BIN")
        .ok()
        .filter(|v| !v.is_empty())
        .or_else(|| {
            env::current_exe()
                .ok()
                .map(|p| p.to_string_lossy().into_owned())
        })
        .unwrap_or_else(|| "h1".to_owned());
    let output = Command::new(&program)
        .args(["preview", arg])
        .stdin(std::process::Stdio::null())
        .output()
        .map_err(|e| format!("cannot run {program}: {e}"))?;
    if !output.status.success() {
        let text = String::from_utf8_lossy(&output.stderr);
        let first = text
            .lines()
            .find(|l| !l.trim().is_empty())
            .unwrap_or("h1 preview failed");
        return Err(first.trim().to_owned());
    }
    preview::parse(&String::from_utf8_lossy(&output.stdout))
}

fn manifest_node(doc: &Preview, node: &preview::Node) -> crate::graphspec::Node {
    let warnings = doc.warnings_for(&node.name).count();
    let tag = if warnings > 0 {
        format!(
            "⚠ {warnings} warning{}",
            if warnings == 1 { "" } else { "s" }
        )
    } else {
        "planned".to_owned()
    };
    crate::graphspec::Node {
        name: node.name.clone(),
        harness: node.harness.clone(),
        role: node.role.clone(),
        parent: node.parent.clone(),
        requested_model: node.requested_model.clone(),
        model: node.model.clone().unwrap_or_default(),
        model_label: node
            .model_label
            .clone()
            .unwrap_or_else(|| node.model_text()),
        pick: crate::graphspec::PickInfo {
            via: tag,
            ..Default::default()
        },
        tools: node.tools.clone(),
        vault_env: Vec::new(),
    }
}

impl PreviewState {
    pub fn new(doc: Preview) -> Self {
        let mut overlay = crate::graphspec::Overlay::default();
        let mut probes = Vec::new();
        for node in &doc.nodes {
            let info = crate::graphspec::NodeInfo {
                team: doc.team.clone(),
                run: "preview".to_owned(),
                source: doc.source.clone(),
                trace_dir: None,
                node: manifest_node(&doc, node),
            };
            probes.push(planned_probe(&info));
            overlay.by_name.insert(node.name.clone(), info);
        }
        // Parents come from the preview itself; member edges give the parentless nodes theirs.
        for edge in &doc.edges {
            if let Some(probe) = probes.iter_mut().find(|p| p.entry.name == edge.to) {
                probe.entry.parent.get_or_insert_with(|| edge.from.clone());
            }
        }
        let labs = arrange_with(
            &probes,
            &HashMap::new(),
            &crate::graphspec::Overlay::default(),
        );
        let selected = doc.nodes.first().map(|n| n.name.clone());
        PreviewState {
            doc,
            labs,
            overlay,
            selected,
        }
    }

    pub fn selected_node(&self) -> Option<&preview::Node> {
        self.selected
            .as_deref()
            .and_then(|name| self.doc.node(name))
    }

    pub fn step(&mut self, delta: isize) {
        if self.doc.nodes.is_empty() {
            return;
        }
        let current = self
            .selected
            .as_deref()
            .and_then(|s| self.doc.nodes.iter().position(|n| n.name == s))
            .unwrap_or(0) as isize;
        let next = (current + delta).clamp(0, self.doc.nodes.len() as isize - 1) as usize;
        self.selected = Some(self.doc.nodes[next].name.clone());
    }

    pub fn walk(&mut self, to_parent: bool) {
        let Some(node) = self.selected_node() else {
            return;
        };
        let target = if to_parent {
            node.parent.clone().filter(|p| self.doc.node(p).is_some())
        } else {
            self.doc
                .nodes
                .iter()
                .find(|n| n.parent.as_deref() == Some(node.name.as_str()))
                .map(|n| n.name.clone())
        };
        if target.is_some() {
            self.selected = target;
        }
    }

    /// Diff against the live sessions. `would stop`: running sessions that are not in the
    /// preview but hang under one of its nodes (parent in the preview, or the team prefix).
    pub fn diff(&self, running: &[(String, Option<String>)]) -> Diff {
        let planned: HashSet<&str> = self.doc.nodes.iter().map(|n| n.name.as_str()).collect();
        let live: HashSet<&str> = running.iter().map(|(n, _)| n.as_str()).collect();
        let mut diff = Diff::default();
        for node in &self.doc.nodes {
            if live.contains(node.name.as_str()) {
                diff.already_running.push(node.name.clone())
            } else {
                diff.will_start.push(node.name.clone())
            }
        }
        let prefix = self
            .doc
            .prefix
            .as_deref()
            .filter(|p| !p.is_empty())
            .map(|p| format!("{p}-"));
        for (name, parent) in running {
            if planned.contains(name.as_str()) {
                continue;
            }
            let under = parent.as_deref().is_some_and(|p| planned.contains(p));
            let prefixed = prefix.as_deref().is_some_and(|p| name.starts_with(p));
            if under || prefixed {
                diff.would_stop.push(name.clone());
            }
        }
        diff
    }
}

impl App {
    /// Loads `arg` and switches to the preview view; on failure shows the error and stays.
    pub(super) fn load_preview(&mut self, arg: &str) {
        match load_source(arg) {
            Ok(doc) => self.show_preview(doc),
            Err(error) => self.say(format!("preview: {error}"), true),
        }
    }

    pub(super) fn show_preview(&mut self, doc: Preview) {
        let nodes = doc.nodes.len();
        self.preview = Some(PreviewState::new(doc));
        if self.view != View::Preview {
            self.view_before_preview = self.view;
        }
        self.view = View::Preview;
        self.say(
            format!(
                "preview loaded: {nodes} planned node{}",
                if nodes == 1 { "" } else { "s" }
            ),
            false,
        );
    }

    /// Running sessions as (name, parent).
    pub(super) fn running(&self) -> Vec<(String, Option<String>)> {
        self.labs
            .iter()
            .filter(|l| l.state() != "planned")
            .map(|l| (l.name().to_owned(), l.parent.clone()))
            .collect()
    }

    pub(super) fn preview_diff(&self) -> Diff {
        self.preview
            .as_ref()
            .map(|p| p.diff(&self.running()))
            .unwrap_or_default()
    }

    /// `p` from any view: toggle into the preview, or back out of it.
    pub(super) fn toggle_preview(&mut self) {
        if self.view == View::Preview {
            self.view = self.view_before_preview;
        } else if self.preview.is_some() {
            self.view_before_preview = self.view;
            self.view = View::Preview;
        } else {
            self.say(
                "no preview loaded: press P and type a .yah or .json path",
                true,
            );
        }
    }

    /// Keys of the preview view. Returns false for keys it does not own.
    pub(super) fn preview_key(&mut self, key: KeyEvent) -> bool {
        match key.code {
            KeyCode::Char('p' | 'q') | KeyCode::Esc => self.toggle_preview(),
            KeyCode::Char('u') => self.mode = Mode::PreviewSummary,
            KeyCode::Enter => {
                if self
                    .preview
                    .as_ref()
                    .is_some_and(|p| p.selected_node().is_some())
                {
                    self.mode = Mode::PreviewCommand;
                }
            }
            KeyCode::Down | KeyCode::Char('j') => self.preview_do(|p| p.step(1)),
            KeyCode::Up | KeyCode::Char('k') => self.preview_do(|p| p.step(-1)),
            KeyCode::Left | KeyCode::Char('h') => self.preview_do(|p| p.walk(true)),
            KeyCode::Right | KeyCode::Char('l') => self.preview_do(|p| p.walk(false)),
            KeyCode::Char('g') | KeyCode::Home => self.preview_do(|p| p.step(isize::MIN / 2)),
            KeyCode::Char('G') | KeyCode::End => self.preview_do(|p| p.step(isize::MAX / 2)),
            KeyCode::Char('?') => self.mode = Mode::Help,
            _ => return false,
        }
        true
    }

    fn preview_do(&mut self, act: impl FnOnce(&mut PreviewState)) {
        if let Some(p) = self.preview.as_mut() {
            act(p);
        }
    }

    /// Text editing of the `P` prompt (Esc cancels, Enter loads).
    pub(super) fn load_prompt_key(&mut self, mut text: String, key: KeyEvent) {
        match key.code {
            KeyCode::Esc => self.mode = Mode::Normal,
            KeyCode::Enter => {
                self.mode = Mode::Normal;
                let path = text.trim().to_owned();
                if !path.is_empty() {
                    self.load_preview(&path);
                }
            }
            KeyCode::Backspace => {
                text.pop();
                self.mode = Mode::LoadPreview(text);
            }
            KeyCode::Char(c) if !key.modifiers.contains(KeyModifiers::CONTROL) => {
                text.push(c);
                self.mode = Mode::LoadPreview(text);
            }
            _ => {}
        }
    }
}

fn red() -> Style {
    Style::default().fg(RED)
}

fn label(text: &str) -> Span<'static> {
    Span::styled(
        format!("{text:<10}"),
        Style::default().fg(ORANGE).add_modifier(Modifier::BOLD),
    )
}

pub(super) fn draw_preview_view(frame: &mut Frame, area: Rect, app: &mut App) {
    let diff = app.preview_diff();
    let Some(state) = app.preview.as_ref() else {
        let block = titled_block("preview", 0, 0, "");
        let inner = block.inner(area);
        frame.render_widget(block, area);
        frame.render_widget(
            Paragraph::new(Line::from("No preview loaded: press P and type a .yah or .json path (or run h1 console --preview FILE)").alignment(Alignment::Center))
                .style(Style::default().fg(GRAY)),
            Rect { y: inner.y + inner.height / 2, height: 1, ..inner },
        );
        return;
    };
    let doc = &state.doc;
    let block = titled_block("preview", doc.nodes.len(), doc.nodes.len(), "");
    let inner = block.inner(area);
    frame.render_widget(block, area);
    if inner.height < 4 {
        return;
    }
    let errors = doc
        .warnings
        .iter()
        .filter(|w| w.severity == Severity::Error)
        .count();
    let mut head = vec![
        Span::styled(
            format!(
                " PLANNED{} · team {} · {} · {} nodes ",
                if doc.has_errors() { " (INVALID)" } else { "" },
                doc.team,
                doc.source,
                doc.nodes.len()
            ),
            Style::default().fg(DIM).add_modifier(Modifier::BOLD),
        ),
        Span::styled(
            format!(
                "· start {} · running {} · stop {} ",
                diff.will_start.len(),
                diff.already_running.len(),
                diff.would_stop.len()
            ),
            Style::default().fg(GRAY),
        ),
    ];
    if !doc.warnings.is_empty() {
        head.push(Span::styled(
            format!(
                "· {} warning{} ({errors} error{})",
                doc.warnings.len(),
                if doc.warnings.len() == 1 { "" } else { "s" },
                if errors == 1 { "" } else { "s" }
            ),
            red().add_modifier(Modifier::BOLD),
        ));
    }
    let [head_area, rest] =
        Layout::vertical([Constraint::Length(1), Constraint::Min(3)]).areas(inner);
    frame.render_widget(Paragraph::new(Line::from(head)), head_area);
    let side_w = 46.min(rest.width / 2);
    let [graph_area, side_area] =
        Layout::horizontal([Constraint::Min(10), Constraint::Length(side_w)]).areas(rest);

    // graph: the same layout and widgets as the live graph
    let nodes = layout(&state.labs);
    let focus_lab = state
        .selected
        .as_ref()
        .and_then(|name| state.labs.iter().position(|l| l.name() == name));
    let focus = focus_lab.and_then(|lab| nodes.iter().position(|n| n.lab == Some(lab)));
    let (mut canvas, origin) = draw_graph(&state.labs, &nodes, focus, &state.overlay);
    for (id, node) in nodes.iter().enumerate() {
        let Some(l) = node.lab else { continue };
        if focus != Some(id) && doc.warnings_for(state.labs[l].name()).next().is_some() {
            let (x, y) = origin[id];
            let count = doc.warnings_for(state.labs[l].name()).count();
            let text = format!("⚠ {count} warning{}", if count == 1 { "" } else { "s" });
            canvas.text(x + 2, y + 3, &fit(&text, NODE_W - 4), red());
        }
    }
    let (fx, fy) = focus.map(|f| origin[f]).unwrap_or((0, 0));
    let (view_w, view_h) = (graph_area.width as usize, graph_area.height as usize);
    let ox = (fx + NODE_W).saturating_sub(view_w);
    let oy = (fy + NODE_H_TALL).saturating_sub(view_h);
    let shown: Vec<Line> = canvas
        .lines()
        .into_iter()
        .skip(oy)
        .map(|line| clip_line(line, ox, view_w))
        .collect();
    frame.render_widget(Paragraph::new(shown), graph_area);

    // side panel
    let panel = Block::bordered()
        .border_style(Style::default().fg(DIM))
        .title(Span::styled(" selected ", Style::default().fg(GRAY)));
    let panel_inner = panel.inner(side_area);
    frame.render_widget(panel, side_area);
    let mut lines: Vec<Line> = Vec::new();
    if let Some(node) = state.selected_node() {
        let status = if diff.already_running.contains(&node.name) {
            "already running"
        } else {
            "will start"
        };
        lines.push(Line::from(vec![
            label("Name"),
            Span::styled(
                node.name.clone(),
                Style::default()
                    .fg(Color::White)
                    .add_modifier(Modifier::BOLD),
            ),
        ]));
        lines.push(Line::from(vec![
            label("State"),
            Span::styled(format!("planned · {status}"), Style::default().fg(DIM)),
        ]));
        lines.push(Line::from(vec![
            label("Role"),
            Span::raw(node.role.clone()),
        ]));
        lines.push(Line::from(vec![
            label("Parent"),
            Span::raw(node.parent.clone().unwrap_or_else(|| "-".into())),
        ]));
        lines.push(Line::from(vec![
            label("Model"),
            Span::raw(match node.model_status {
                preview::ModelStatus::Pinned => node.model_text(),
                preview::ModelStatus::Pending => "pending (decided at up)".to_owned(),
                preview::ModelStatus::Unknown => "unknown model".to_owned(),
            }),
        ]));
        if let Some(cwd) = &node.cwd {
            lines.push(Line::from(vec![label("Cwd"), Span::raw(cwd.clone())]));
        }
        for warning in doc.warnings_for(&node.name) {
            lines.push(Line::from(Span::styled(
                format!("! {}", warning.message),
                red(),
            )));
        }
        lines.push(Line::from(Span::styled(
            "Command (enter for full)",
            Style::default().fg(AQUA).add_modifier(Modifier::BOLD),
        )));
        lines.push(Line::from(Span::styled(
            node.open_command.clone(),
            Style::default().fg(GRAY),
        )));
        lines.push(Line::from(Span::styled(
            "Env",
            Style::default().fg(AQUA).add_modifier(Modifier::BOLD),
        )));
        if node.env.is_empty() {
            lines.push(Line::from(Span::styled("  -", Style::default().fg(GRAY))));
        }
        for entry in &node.env {
            lines.push(Line::from(Span::styled(
                format!("  {}={}", entry.key, entry.value),
                Style::default().fg(GRAY),
            )));
        }
    } else {
        lines.push(Line::from(Span::styled(
            "no node selected",
            Style::default().fg(GRAY),
        )));
    }
    frame.render_widget(
        Paragraph::new(lines).wrap(Wrap { trim: false }),
        panel_inner,
    );
}

pub(super) fn draw_preview_command(frame: &mut Frame, area: Rect, app: &App) {
    let Some(node) = app.preview.as_ref().and_then(|p| p.selected_node()) else {
        return;
    };
    let rect = centered(area, area.width.saturating_sub(4).min(110), 9);
    frame.render_widget(Clear, rect);
    let title = Span::styled(
        format!(
            " open command · {} (planned, nothing is started) ",
            node.name
        ),
        Style::default().fg(AQUA),
    );
    let block = Block::bordered()
        .border_style(Style::default().fg(BLUE))
        .title(title)
        .title_alignment(Alignment::Center);
    let mut lines = vec![Line::from(Span::styled(
        node.open_command.clone(),
        Style::default().fg(Color::White),
    ))];
    lines.push(Line::from(""));
    for entry in &node.env {
        lines.push(Line::from(Span::styled(
            format!("env {}={}", entry.key, entry.value),
            Style::default().fg(GRAY),
        )));
    }
    frame.render_widget(
        Paragraph::new(lines)
            .block(block)
            .wrap(Wrap { trim: false }),
        rect,
    );
}

pub(super) fn draw_preview_summary(frame: &mut Frame, area: Rect, app: &App) {
    let Some(state) = app.preview.as_ref() else {
        return;
    };
    let diff = app.preview_diff();
    let rect = centered(
        area,
        area.width.saturating_sub(4).min(80),
        area.height.saturating_sub(4).clamp(8, 24),
    );
    frame.render_widget(Clear, rect);
    let heading = |t: String| {
        Line::from(Span::styled(
            t,
            Style::default().fg(AQUA).add_modifier(Modifier::BOLD),
        ))
    };
    let list = |names: &[String]| -> Line<'static> {
        Line::from(Span::styled(
            format!(
                "  {}",
                if names.is_empty() {
                    "-".to_owned()
                } else {
                    names.join(", ")
                }
            ),
            Style::default().fg(GRAY),
        ))
    };
    let mut lines = vec![
        heading(format!(
            "up would start {} of {} nodes in team {}",
            diff.will_start.len(),
            state.doc.nodes.len(),
            state.doc.team
        )),
        heading(format!("will start ({})", diff.will_start.len())),
        list(&diff.will_start),
        heading(format!("already running ({})", diff.already_running.len())),
        list(&diff.already_running),
        heading(format!("would stop ({})", diff.would_stop.len())),
        list(&diff.would_stop),
        heading(format!("warnings ({})", state.doc.warnings.len())),
    ];
    if state.doc.warnings.is_empty() {
        lines.push(Line::from(Span::styled(
            "  none",
            Style::default().fg(GRAY),
        )));
    }
    for w in &state.doc.warnings {
        let who = w
            .node
            .as_deref()
            .map(|n| format!("{n}: "))
            .unwrap_or_default();
        lines.push(Line::from(Span::styled(
            format!("  {who}{}", w.message),
            red(),
        )));
    }
    let block = Block::bordered()
        .border_style(Style::default().fg(BLUE))
        .title(Span::styled(
            " would-up summary · preview only ",
            Style::default().fg(AQUA),
        ))
        .title_alignment(Alignment::Center);
    frame.render_widget(
        Paragraph::new(lines)
            .block(block)
            .wrap(Wrap { trim: false }),
        rect,
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    const DOC: &str = r#"{
        "version": 1, "team": "demo", "source": "examples/demo.yah", "root": "commander", "prefix": null,
        "nodes": [
          { "name": "commander", "harness": "commander", "role": "commander", "parent": null,
            "requested_model": "sonnet", "model": "anthropic/claude-sonnet-5-5", "model_label": "sonnet",
            "model_status": "pinned", "tools": [], "cwd": "/work",
            "env": [ { "key": "API_KEY", "value": "***", "source": "literal", "masked": true } ],
            "open_command": "h1 open -n commander --role commander --model anthropic/claude-sonnet-5-5 -- pi" },
          { "name": "builder", "harness": "builder", "role": "worker", "parent": "commander",
            "requested_model": "system-one", "model": null, "model_label": null, "model_status": "pending",
            "tools": [], "cwd": "/nope", "env": [ { "key": "GREETING", "value": "${env.GREETING}", "source": "env", "masked": false } ],
            "open_command": "h1 open -n builder --role worker --parent commander --model system-one -- pi" },
          { "name": "tester", "harness": "tester", "role": "worker", "parent": "commander",
            "requested_model": "system-one", "model": null, "model_label": null, "model_status": "pending",
            "tools": [], "cwd": null, "env": [], "open_command": "h1 open -n tester --role worker --parent commander --model system-one -- pi" }
        ],
        "edges": [ { "from": "commander", "to": "builder", "kind": "parent" }, { "from": "commander", "to": "tester", "kind": "parent" } ],
        "warnings": [ { "severity": "warn", "code": "missing_cwd", "node": "builder", "message": "cwd \"/nope\" does not exist" } ]
    }"#;

    fn running(name: &str, parent: Option<&str>) -> Probe {
        let info = crate::graphspec::NodeInfo {
            team: String::new(),
            run: String::new(),
            source: String::new(),
            trace_dir: None,
            node: crate::graphspec::Node {
                name: name.into(),
                role: "worker".into(),
                parent: parent.map(Into::into),
                ..Default::default()
            },
        };
        let mut probe = planned_probe(&info);
        probe.state = "working".into();
        probe.entry.started_ms = 1;
        probe
    }

    fn app() -> App {
        let mut app = App::new(View::Labs, 1000);
        app.labs = arrange(
            &[
                running("commander", None),
                running("old-helper", Some("commander")),
            ],
            &HashMap::new(),
        );
        app.reselect();
        app.show_preview(preview::parse(DOC).unwrap());
        app
    }

    fn press(app: &mut App, code: KeyCode) {
        app.key(KeyEvent::new(code, KeyModifiers::NONE));
    }

    #[test]
    fn renders_planned_graph_panel_and_warnings_at_a_fixed_size() {
        let mut app = app();
        let text = render_text(&mut app, 150, 36).unwrap();
        for needle in [
            "PLANNED",
            "team demo",
            "○ commander",
            "○ builder",
            "○ tester",
            "planned",
            "⚠ 1 warning",
            "1 warning (0 errors)",
            "selected",
            "h1 open -n commander",
            "API_KEY=***",
            "planned · already running",
        ] {
            assert!(text.contains(needle), "missing {needle:?} in:\n{text}");
        }
        assert!(
            !text.contains("● commander"),
            "nothing may look live:\n{text}"
        );
        assert_eq!(text.lines().count(), 36.min(text.lines().count()));
    }

    #[test]
    fn diff_lists_start_running_and_stop() {
        let app = app();
        let diff = app.preview_diff();
        assert_eq!(diff.will_start, ["builder", "tester"]);
        assert_eq!(diff.already_running, ["commander"]);
        assert_eq!(diff.would_stop, ["old-helper"]);
    }

    #[test]
    fn keys_enter_u_q_and_p() {
        let mut app = app();
        press(&mut app, KeyCode::Down);
        assert_eq!(
            app.preview.as_ref().unwrap().selected.as_deref(),
            Some("builder")
        );
        press(&mut app, KeyCode::Enter);
        assert_eq!(app.mode, Mode::PreviewCommand);
        let text = render_text(&mut app, 150, 36).unwrap();
        assert!(
            text.contains("open command · builder")
                && text.contains("--model system-one")
                && text.contains("env GREETING=${env.GREETING}"),
            "{text}"
        );
        press(&mut app, KeyCode::Char('q'));
        assert_eq!(app.mode, Mode::Normal);
        assert_eq!(app.view, View::Preview);
        press(&mut app, KeyCode::Char('u'));
        let text = render_text(&mut app, 150, 36).unwrap();
        for needle in [
            "would-up summary",
            "will start (2)",
            "already running (1)",
            "would stop (1)",
            "old-helper",
            "cwd \"/nope\" does not exist",
        ] {
            assert!(text.contains(needle), "missing {needle:?} in:\n{text}");
        }
        press(&mut app, KeyCode::Esc);
        press(&mut app, KeyCode::Char('q'));
        assert_eq!(app.view, View::Labs, "q leaves the preview");
        press(&mut app, KeyCode::Char('p'));
        assert_eq!(app.view, View::Preview, "p toggles back in");
        press(&mut app, KeyCode::Char('p'));
        assert_eq!(app.view, View::Labs);
    }

    #[test]
    fn p_without_a_preview_says_how_to_load_one_and_p_prompt_loads_json() {
        let mut app = App::new(View::Labs, 1000);
        press(&mut app, KeyCode::Char('p'));
        assert_eq!(app.view, View::Labs);
        assert!(
            app.flash
                .as_ref()
                .is_some_and(|(t, _, err)| t.contains("press P") && *err)
        );
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("p.json");
        std::fs::write(&path, DOC).unwrap();
        press(&mut app, KeyCode::Char('P'));
        for c in path.to_string_lossy().chars() {
            press(&mut app, KeyCode::Char(c));
        }
        press(&mut app, KeyCode::Enter);
        assert_eq!(app.view, View::Preview);
        assert_eq!(app.preview.as_ref().unwrap().doc.nodes.len(), 3);
    }

    #[test]
    fn loading_a_preview_is_side_effect_free() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("p.json");
        std::fs::write(&path, DOC).unwrap();
        let before: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        let sessions_before = session::session_dir().join("graphs").exists();
        let mut app = App::new(View::Labs, 1000);
        app.load_preview(path.to_str().unwrap());
        let _ = render_text(&mut app, 150, 36).unwrap();
        let after: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(before, after, "no files created or removed");
        assert_eq!(
            sessions_before,
            session::session_dir().join("graphs").exists(),
            "no manifest dir created"
        );
        assert!(app.labs.is_empty(), "no sessions appeared");
    }

    #[test]
    fn a_bad_source_shows_an_error_and_keeps_the_view() {
        let mut app = App::new(View::Labs, 1000);
        app.load_preview("/definitely/not/here.json");
        assert_eq!(app.view, View::Labs);
        assert!(
            app.flash
                .as_ref()
                .is_some_and(|(t, _, err)| t.starts_with("preview:") && *err)
        );
    }
}
