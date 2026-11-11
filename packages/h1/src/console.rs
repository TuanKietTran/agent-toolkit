//! `h1 console`: a k9s-style terminal UI over every running lab.
//!
//! It reads the same session registry and host sockets as `list` and `status`, so it needs no
//! daemon. Views: `labs` (table), `graph` (the commander -> manager -> worker tree drawn as nodes
//! and edges, with a live activity sparkline) and `models`. Run without `--here` it opens itself in
//! a new terminal window (Ghostty on macOS, see `open_terminal_window`).

use std::collections::{HashMap, HashSet, VecDeque};

use ratatui::{
    Frame, Terminal,
    backend::TestBackend,
    crossterm::event::{self, Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers},
    layout::{Alignment, Constraint, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Cell, Clear, Paragraph, Row, Sparkline, Table, TableState, Wrap},
};

use super::*;
use agents::{AgentRec, Registry};
use commands::{human_duration, request_with_timeout};

mod preview_view;
use preview_view::{PreviewState, draw_preview_command, draw_preview_summary, draw_preview_view};

const AQUA: Color = Color::Rgb(0, 255, 255);
const BLUE: Color = Color::Rgb(30, 144, 255);
const PINK: Color = Color::Rgb(255, 0, 255);
const ORANGE: Color = Color::Rgb(255, 165, 0);
const GREEN: Color = Color::Rgb(50, 205, 50);
const RED: Color = Color::Rgb(255, 69, 58);
const YELLOW: Color = Color::Rgb(255, 215, 0);
const PURPLE: Color = Color::Rgb(186, 120, 255);
const GRAY: Color = Color::Rgb(128, 128, 128);
const DIM: Color = Color::Rgb(90, 90, 90);

/// Samples kept per lab for the activity sparkline.
const HISTORY: usize = 60;
const BARS: [char; 8] = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

#[derive(Debug, Args)]
pub(crate) struct ConsoleArgs {
    /// Run in this terminal instead of opening a new window.
    #[arg(long)]
    here: bool,
    /// Terminal app to open on macOS and Linux. Defaults to $H1_TERMINAL, then Ghostty on macOS.
    #[arg(long, value_name = "NAME")]
    terminal: Option<String>,
    /// Milliseconds between refreshes.
    #[arg(long, default_value_t = 1000, value_name = "MS")]
    interval_ms: u64,
    /// Quiet time (ms) after which a lab counts as stalled.
    #[arg(long, default_value_t = 8000, value_name = "MS")]
    stalled_ms: u64,
    /// Print one frame as text and exit (no terminal needed): a check for scripts and tests.
    #[arg(long)]
    snapshot: bool,
    /// View for the first frame (and for --snapshot): labs, graph or models.
    #[arg(long, default_value = "labs", value_name = "VIEW")]
    view: String,
    /// Agent registry written by the observer (default: $H1_AGENTS, then ~/.h1/agents.json).
    #[arg(long, value_name = "PATH")]
    agents: Option<PathBuf>,
    /// Preview a team without deploying it: a .yah file (via `graphloop preview`) or a preview .json.
    #[arg(long, value_name = "FILE")]
    preview: Option<String>,
    /// Width of the --snapshot frame.
    #[arg(long, default_value_t = 150)]
    width: u16,
    /// Height of the --snapshot frame.
    #[arg(long, default_value_t = 36)]
    height: u16,
}

pub(crate) fn run(args: ConsoleArgs) -> Result<i32> {
    let mut view = View::parse(&args.view).ok_or_else(|| {
        anyhow!(
            "unknown view {:?}: use labs, graph, models, agents, events or preview",
            args.view
        )
    })?;
    if args.preview.is_some() {
        view = View::Preview;
    }
    if args.snapshot {
        return snapshot(&args, view);
    }
    if !args.here {
        let argv = vec![
            "console".to_owned(),
            "--here".to_owned(),
            "--view".to_owned(),
            view.name().to_owned(),
            "--interval-ms".to_owned(),
            args.interval_ms.to_string(),
            "--stalled-ms".to_owned(),
            args.stalled_ms.to_string(),
        ];
        let mut argv = argv;
        if let Some(file) = &args.preview {
            argv.push("--preview".to_owned());
            argv.push(file.clone());
        }
        open_terminal_window(&argv, args.terminal.as_deref())?;
        println!("opened the lab console in a new window");
        return Ok(0);
    }
    if !io::stdin().is_terminal() || !io::stdout().is_terminal() {
        return Err(anyhow!(
            "--here needs a terminal; drop it to open a new window, or use --snapshot"
        ));
    }
    tui(&args, view)?;
    Ok(0)
}

// ---------------------------------------------------------------- data

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum View {
    Labs,
    Graph,
    Models,
    Agents,
    Events,
    Preview,
}

impl View {
    fn parse(text: &str) -> Option<Self> {
        match text.trim().to_ascii_lowercase().as_str() {
            "labs" | "lab" | "l" | "ls" | "sessions" => Some(View::Labs),
            "graph" | "g" | "topology" | "tree" | "xray" => Some(View::Graph),
            "models" | "model" | "m" => Some(View::Models),
            "agents" | "all" | "fleet" | "everyone" => Some(View::Agents),
            "events" | "event" | "e" => Some(View::Events),
            "preview" | "plan" | "pv" => Some(View::Preview),
            _ => None,
        }
    }
    fn name(self) -> &'static str {
        match self {
            View::Labs => "labs",
            View::Graph => "graph",
            View::Models => "models",
            View::Agents => "agents",
            View::Events => "events",
            View::Preview => "preview",
        }
    }
}

/// What one look at one session showed.
#[derive(Debug, Clone)]
struct Probe {
    entry: session::Entry,
    state: String,
    screen: String,
    quiet_ms: u64,
    uptime_ms: u64,
    bytes_out: u64,
    window_title: String,
}

fn look(entry: &session::Entry, stalled_ms: u64) -> Probe {
    let socket = PathBuf::from(&entry.socket);
    let timeout = Duration::from_millis(1500);
    let gone = |entry: &session::Entry| Probe {
        entry: entry.clone(),
        state: "gone".into(),
        screen: String::new(),
        quiet_ms: 0,
        uptime_ms: 0,
        bytes_out: 0,
        window_title: String::new(),
    };
    let Ok(answer) = request_with_timeout(&socket, json!({ "op": "screen" }), timeout) else {
        return gone(entry);
    };
    let screen = answer
        .get("screen")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let status = request_with_timeout(&socket, json!({ "op": "status" }), timeout).ok();
    let number = |key: &str| {
        status
            .as_ref()
            .and_then(|s| s.get(key))
            .and_then(Value::as_u64)
    };
    let quiet_ms = number("quiet_ms");
    let running = status
        .as_ref()
        .and_then(|s| s.get("running"))
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let state = if !running {
        "exited"
    } else {
        match quiet_ms {
            Some(quiet) => state::classify(&screen, quiet, stalled_ms).name(),
            None if state::is_asking(&screen) => "asking",
            None => "up",
        }
    };
    Probe {
        entry: entry.clone(),
        state: state.into(),
        screen,
        quiet_ms: quiet_ms.unwrap_or(0),
        uptime_ms: number("uptime_ms").unwrap_or(0),
        bytes_out: number("bytes_out").unwrap_or(0),
        window_title: status
            .as_ref()
            .and_then(|s| s.get("window_title"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
    }
}

fn probe_all(stalled_ms: u64) -> Vec<Probe> {
    let entries = session::entries();
    let mut found: Vec<Probe> = thread::scope(|scope| {
        let handles: Vec<_> = entries
            .iter()
            .map(|entry| scope.spawn(move || look(entry, stalled_ms)))
            .collect();
        handles
            .into_iter()
            .filter_map(|handle| handle.join().ok())
            .collect()
    });
    // A host that no longer answers is hidden, never forgotten: its record is what `h1 recover` reopens from.
    found.retain(|probe| probe.state != "gone");
    found.sort_by_key(|probe| (probe.entry.started_ms, probe.entry.name.clone()));
    found
}

/// A row of the lab table, with the hierarchy worked out.
#[derive(Debug, Clone)]
struct Lab {
    probe: Probe,
    role: String,
    parent: Option<String>,
    depth: usize,
    /// Tree connector shown in front of the name (`├─ `, `└─ `).
    prefix: String,
    history: Vec<u64>,
}

impl Lab {
    fn name(&self) -> &str {
        &self.probe.entry.name
    }
    fn state(&self) -> &str {
        &self.probe.state
    }
    fn model(&self) -> String {
        self.probe.entry.model_label().unwrap_or_else(|| "-".into())
    }
    fn program(&self) -> String {
        self.probe
            .entry
            .command
            .first()
            .map(|c| c.rsplit('/').next().unwrap_or(c).to_owned())
            .unwrap_or_default()
    }
}

fn state_color(state: &str) -> Color {
    match state {
        "planned" => DIM,
        "working" | "up" => GREEN,
        "asking" => YELLOW,
        "stalled" => ORANGE,
        "exited" | "gone" => RED,
        _ => GRAY,
    }
}

fn state_glyph(state: &str) -> &'static str {
    match state {
        "planned" => "○",
        "working" | "up" => "●",
        "asking" => "◆",
        "stalled" => "◌",
        _ => "✕",
    }
}

/// Orders labs as a forest (parents first, children under them, oldest first) and fills in role,
/// depth and connectors. A parent that is not running, or a cycle, makes a lab a root.
#[allow(dead_code)]
fn arrange(probes: &[Probe], history: &HashMap<String, VecDeque<u64>>) -> Vec<Lab> {
    arrange_with(probes, history, &crate::graphspec::Overlay::default())
}

/// Manifest info for a session name, whether the session is live or only planned.
fn overlay_info<'a>(
    overlay: &'a crate::graphspec::Overlay,
    name: &str,
) -> Option<&'a crate::graphspec::NodeInfo> {
    overlay
        .get(name)
        .or_else(|| overlay.planned.iter().find(|info| info.node.name == name))
}

/// `provider/id tag` for a manifest node, e.g. `anthropic/claude-sonnet-5-5 s1 R3`.
fn resolved_text(info: &crate::graphspec::NodeInfo) -> String {
    let model = if info.node.model.is_empty() {
        &info.node.model_label
    } else {
        &info.node.model
    };
    if model.is_empty() {
        info.node.pick_tag()
    } else {
        format!("{} {}", model, info.node.pick_tag())
    }
}

/// Model id without its `provider/` prefix, e.g. `claude-sonnet-5-5`.
fn short_model(model: &str) -> &str {
    match model.split_once('/') {
        Some((_, id)) if !id.is_empty() => id,
        _ => model,
    }
}

/// The resolved model for a manifest node, with the provider prefix dropped.
fn manifest_model(info: &crate::graphspec::NodeInfo) -> String {
    let model = if info.node.model.is_empty() {
        &info.node.model_label
    } else {
        &info.node.model
    };
    short_model(model).to_owned()
}

/// Graph line 2 for a manifest node: `role · model` when the full model fits that
/// way, otherwise the full model alone — the model itself is never truncated to
/// make room for the role.
fn manifest_line(role: &str, info: &crate::graphspec::NodeInfo, inner: usize) -> String {
    let model = manifest_model(info);
    let full = format!("{role} · {model}");
    if full.chars().count() <= inner {
        full
    } else {
        model
    }
}

/// A synthetic probe for a manifest node whose session is not up yet (state `planned`).
fn planned_probe(info: &crate::graphspec::NodeInfo) -> Probe {
    Probe {
        entry: session::Entry {
            name: info.node.name.clone(),
            pid: 0,
            socket: String::new(),
            command: Vec::new(),
            cwd: None,
            title: None,
            cols: 0,
            rows: 0,
            started_ms: u64::MAX,
            role: if info.node.role.is_empty() {
                None
            } else {
                Some(info.node.role.clone())
            },
            parent: info.node.parent.clone(),
            model: if info.node.model.is_empty() {
                None
            } else {
                Some(info.node.model.clone())
            },
            brief: None,
            resume_log: None,
            new_cmd: None,
            ready_regex: None,
            auto_rearm: false,
            env_names: Vec::new(),
        },
        state: "planned".into(),
        screen: String::new(),
        quiet_ms: 0,
        uptime_ms: 0,
        bytes_out: 0,
        window_title: String::new(),
    }
}

fn arrange_with(
    probes: &[Probe],
    history: &HashMap<String, VecDeque<u64>>,
    overlay: &crate::graphspec::Overlay,
) -> Vec<Lab> {
    // Effective parent: the registry parent, else the manifest node's parent, else the
    // `from` of a manifest `member` edge into this node. Rewriting the entry parent lets
    // the forest walk and the graph layout below share the one answer.
    let all_names: HashSet<&str> = probes.iter().map(|p| p.entry.name.as_str()).collect();
    let mut owned: Vec<Probe> = probes.to_vec();
    for probe in owned.iter_mut() {
        let live_parent = probe
            .entry
            .parent
            .as_deref()
            .filter(|parent| all_names.contains(parent) && *parent != probe.entry.name)
            .map(str::to_owned);
        if live_parent.is_some() {
            continue;
        }
        let fallback = overlay_info(overlay, &probe.entry.name)
            .and_then(|info| info.node.parent.clone())
            .or_else(|| {
                overlay
                    .edges
                    .iter()
                    .find(|edge| {
                        edge.to == probe.entry.name
                            && edge.kind == crate::graphspec::EdgeKind::Member
                    })
                    .map(|edge| edge.from.clone())
            });
        if let Some(parent) = fallback
            .filter(|parent| all_names.contains(parent.as_str()) && *parent != probe.entry.name)
        {
            probe.entry.parent = Some(parent);
        }
    }
    let probes: &[Probe] = &owned;
    let names: HashSet<&str> = probes.iter().map(|p| p.entry.name.as_str()).collect();
    let parent_of = |p: &Probe| {
        p.entry
            .parent
            .as_deref()
            .filter(|parent| names.contains(parent) && *parent != p.entry.name)
            .map(str::to_owned)
    };
    let mut kids: HashMap<String, Vec<usize>> = HashMap::new();
    let mut roots = Vec::new();
    for (index, probe) in probes.iter().enumerate() {
        match parent_of(probe) {
            Some(parent) => kids.entry(parent).or_default().push(index),
            None => roots.push(index),
        }
    }
    let mut ordered: Vec<Lab> = Vec::new();
    let mut seen: HashSet<usize> = HashSet::new();
    // Shared read-only indexes for the recursive forest walk, grouped so
    // `walk` needs no clippy::too_many_arguments suppression.
    struct Forest<'a> {
        probes: &'a [Probe],
        kids: &'a HashMap<String, Vec<usize>>,
        history: &'a HashMap<String, VecDeque<u64>>,
    }
    fn walk(
        index: usize,
        depth: usize,
        trail: &str,
        last: bool,
        forest: &Forest,
        seen: &mut HashSet<usize>,
        out: &mut Vec<Lab>,
    ) {
        let probes = forest.probes;
        let kids = forest.kids;
        let history = forest.history;
        if !seen.insert(index) {
            return;
        }
        let probe = &probes[index];
        let children = kids.get(&probe.entry.name).cloned().unwrap_or_default();
        let prefix = if depth == 0 {
            String::new()
        } else {
            format!("{trail}{}", if last { "└─ " } else { "├─ " })
        };
        let role = probe.entry.role.clone().unwrap_or_else(|| {
            if !children.is_empty() {
                "manager".into()
            } else if probe.entry.parent.is_some() {
                "worker".into()
            } else {
                "lab".into()
            }
        });
        out.push(Lab {
            probe: probe.clone(),
            role,
            parent: probe.entry.parent.clone(),
            depth,
            prefix,
            history: history
                .get(&probe.entry.name)
                .map(|h| h.iter().copied().collect())
                .unwrap_or_default(),
        });
        let next_trail = if depth == 0 {
            String::new()
        } else {
            format!("{trail}{}", if last { "   " } else { "│  " })
        };
        for (n, child) in children.iter().enumerate() {
            walk(
                *child,
                depth + 1,
                &next_trail,
                n + 1 == children.len(),
                forest,
                seen,
                out,
            );
        }
    }
    let forest = Forest {
        probes,
        kids: &kids,
        history,
    };
    for root in roots {
        walk(root, 0, "", true, &forest, &mut seen, &mut ordered);
    }
    // cycles: nothing above reached them
    for index in 0..probes.len() {
        walk(index, 0, "", true, &forest, &mut seen, &mut ordered);
    }
    ordered
}

// ---------------------------------------------------------------- graph layout

const NODE_W: usize = 30;
const NODE_H: usize = 4;
/// Height of a node that carries manifest info: one extra line for the provenance tag.
const NODE_H_TALL: usize = 5;
const GAP_X: usize = 8;
const GAP_Y: usize = 1;

#[derive(Debug, Clone)]
struct GraphNode {
    /// Index into the arranged labs; `None` is the commander (you).
    lab: Option<usize>,
    depth: usize,
    row: usize,
    parent: Option<usize>,
}

/// Places every lab in a column per depth; a parent sits in the middle of its children.
fn layout(labs: &[Lab]) -> Vec<GraphNode> {
    let index_of: HashMap<&str, usize> = labs
        .iter()
        .enumerate()
        .map(|(i, l)| (l.name(), i))
        .collect();
    let mut nodes = vec![GraphNode {
        lab: None,
        depth: 0,
        row: 0,
        parent: None,
    }];
    let mut kids: Vec<Vec<usize>> = vec![Vec::new()];
    let mut node_of_lab: HashMap<usize, usize> = HashMap::new();
    for (i, lab) in labs.iter().enumerate() {
        let parent_node = lab
            .parent
            .as_deref()
            .and_then(|p| index_of.get(p))
            .and_then(|pi| node_of_lab.get(pi))
            .copied()
            .filter(|_| lab.depth > 0)
            .unwrap_or(0);
        let id = nodes.len();
        nodes.push(GraphNode {
            lab: Some(i),
            depth: nodes[parent_node].depth + 1,
            row: 0,
            parent: Some(parent_node),
        });
        kids.push(Vec::new());
        kids[parent_node].push(id);
        node_of_lab.insert(i, id);
    }
    fn place(id: usize, next_leaf: &mut usize, nodes: &mut Vec<GraphNode>, kids: &[Vec<usize>]) {
        if kids[id].is_empty() {
            nodes[id].row = *next_leaf * 2;
            *next_leaf += 1;
            return;
        }
        for child in &kids[id] {
            place(*child, next_leaf, nodes, kids);
        }
        let first = nodes[kids[id][0]].row;
        let last = nodes[*kids[id].last().unwrap()].row;
        nodes[id].row = (first + last) / 2;
        // keep rows even so every node starts on a stride boundary
        nodes[id].row -= nodes[id].row % 2;
    }
    let mut next_leaf = 0;
    place(0, &mut next_leaf, &mut nodes, &kids);
    nodes
}

#[derive(Clone, Copy)]
struct Glyph {
    ch: char,
    style: Style,
}

struct Canvas {
    width: usize,
    height: usize,
    cells: Vec<Glyph>,
}

impl Canvas {
    fn new(width: usize, height: usize) -> Self {
        Canvas {
            width,
            height,
            cells: vec![
                Glyph {
                    ch: ' ',
                    style: Style::default()
                };
                width * height
            ],
        }
    }
    fn put(&mut self, x: usize, y: usize, ch: char, style: Style) {
        if x < self.width && y < self.height {
            self.cells[y * self.width + x] = Glyph { ch, style };
        }
    }
    fn text(&mut self, x: usize, y: usize, text: &str, style: Style) {
        for (offset, ch) in text.chars().enumerate() {
            self.put(x + offset, y, ch, style);
        }
    }
    fn lines(&self) -> Vec<Line<'static>> {
        (0..self.height)
            .map(|y| {
                let mut spans: Vec<Span<'static>> = Vec::new();
                let mut run = String::new();
                let mut style = Style::default();
                for x in 0..self.width {
                    let glyph = self.cells[y * self.width + x];
                    if glyph.style != style && !run.is_empty() {
                        spans.push(Span::styled(std::mem::take(&mut run), style));
                    }
                    style = glyph.style;
                    run.push(glyph.ch);
                }
                if !run.is_empty() {
                    spans.push(Span::styled(run, style));
                }
                Line::from(spans)
            })
            .collect()
    }
}

fn fit(text: &str, width: usize) -> String {
    let count = text.chars().count();
    if count <= width {
        text.to_owned()
    } else if width <= 1 {
        text.chars().take(width).collect()
    } else {
        let mut cut: String = text.chars().take(width - 1).collect();
        cut.push('…');
        cut
    }
}

/// Draws the graph. Returns the canvas and the (x, y) of every node, indexed like `nodes`.
fn draw_graph(
    labs: &[Lab],
    nodes: &[GraphNode],
    selected: Option<usize>,
    overlay: &crate::graphspec::Overlay,
) -> (Canvas, Vec<(usize, usize)>) {
    let columns = nodes.iter().map(|n| n.depth).max().unwrap_or(0) + 1;
    let rows = nodes.iter().map(|n| n.row).max().unwrap_or(0) / 2 + 1;
    let stride_x = NODE_W + GAP_X;
    let stride_y = NODE_H_TALL + GAP_Y;
    let width = columns * stride_x - GAP_X;
    let height = rows * stride_y - GAP_Y;
    let mut canvas = Canvas::new(width, height);
    let origin: Vec<(usize, usize)> = nodes
        .iter()
        .map(|n| (n.depth * stride_x, n.row / 2 * stride_y))
        .collect();

    // edges first, so boxes sit on top
    let mut kids: Vec<Vec<usize>> = vec![Vec::new(); nodes.len()];
    for (id, node) in nodes.iter().enumerate() {
        if let Some(parent) = node.parent {
            kids[parent].push(id);
        }
    }
    for (parent, children) in kids.iter().enumerate() {
        if children.is_empty() {
            continue;
        }
        let (px, py) = origin[parent];
        let start_x = px + NODE_W;
        let spine_x = start_x + GAP_X / 2;
        let parent_y = py + 1;
        let child_ys: Vec<usize> = children.iter().map(|c| origin[*c].1 + 1).collect();
        let top = child_ys.iter().copied().min().unwrap().min(parent_y);
        let bottom = child_ys.iter().copied().max().unwrap().max(parent_y);
        let edge = Style::default().fg(DIM);
        for x in start_x..spine_x {
            canvas.put(x, parent_y, '─', edge);
        }
        for y in top..=bottom {
            let has_child = child_ys.contains(&y);
            let is_parent = y == parent_y;
            let ch = match (y == top, y == bottom, has_child, is_parent) {
                (true, true, _, _) => '─',
                (true, false, true, true) => '┬',
                (true, false, true, false) => '┌',
                (true, false, false, _) => '┬',
                (false, true, true, true) => '┴',
                (false, true, true, false) => '└',
                (false, true, false, _) => '┴',
                (false, false, true, true) => '┼',
                (false, false, true, false) => '├',
                (false, false, false, true) => '┤',
                (false, false, false, false) => '│',
            };
            canvas.put(spine_x, y, ch, edge);
        }
        for (child, y) in children.iter().zip(&child_ys) {
            let live = nodes[*child]
                .lab
                .map(|l| matches!(labs[l].state(), "working" | "asking"))
                .unwrap_or(false);
            let style = if live {
                Style::default().fg(GREEN)
            } else {
                edge
            };
            let (cx, _) = origin[*child];
            for x in spine_x + 1..cx.saturating_sub(1) {
                canvas.put(x, *y, '─', style);
            }
            canvas.put(cx - 1, *y, '▶', style);
        }
    }

    for (id, node) in nodes.iter().enumerate() {
        let (x, y) = origin[id];
        let focus = selected == Some(id);
        let (border, title, subtitle, tag, color, height) = match node.lab {
            None => (
                AQUA,
                "◆ commander".to_owned(),
                format!(
                    "you · {} lab{}",
                    labs.len(),
                    if labs.len() == 1 { "" } else { "s" }
                ),
                None,
                AQUA,
                NODE_H,
            ),
            Some(l) => {
                let lab = &labs[l];
                let info = overlay_info(overlay, lab.name());
                let (subtitle, tag) = match info {
                    Some(info) => (
                        manifest_line(&lab.role, info, NODE_W - 4),
                        Some(info.node.pick_tag()),
                    ),
                    None => (format!("{} · {}", lab.role, lab.model()), None),
                };
                (
                    state_color(lab.state()),
                    format!("{} {}", state_glyph(lab.state()), lab.name()),
                    subtitle,
                    tag,
                    state_color(lab.state()),
                    if info.is_some() { NODE_H_TALL } else { NODE_H },
                )
            }
        };
        let border_style = if focus {
            Style::default().fg(Color::Black).bg(AQUA)
        } else {
            Style::default().fg(border)
        };
        let body_bg = if focus {
            Style::default().fg(Color::Black).bg(AQUA)
        } else {
            Style::default()
        };
        let (tl, tr, bl, br, h, v) = if focus {
            ('╔', '╗', '╚', '╝', '═', '║')
        } else {
            ('╭', '╮', '╰', '╯', '─', '│')
        };
        for i in 0..NODE_W {
            let (top_ch, bottom_ch) = match i {
                0 => (tl, bl),
                i if i == NODE_W - 1 => (tr, br),
                _ => (h, h),
            };
            canvas.put(x + i, y, top_ch, border_style);
            canvas.put(x + i, y + height - 1, bottom_ch, border_style);
        }
        for row in 1..height - 1 {
            canvas.put(x, y + row, v, border_style);
            canvas.put(x + NODE_W - 1, y + row, v, border_style);
            for i in 1..NODE_W - 1 {
                canvas.put(x + i, y + row, ' ', body_bg);
            }
        }
        let inner = NODE_W - 4;
        let (name_style, state_style) = if focus {
            (
                Style::default()
                    .fg(Color::Black)
                    .bg(AQUA)
                    .add_modifier(Modifier::BOLD),
                Style::default().fg(Color::Black).bg(AQUA),
            )
        } else {
            (
                Style::default().fg(color).add_modifier(Modifier::BOLD),
                Style::default().fg(color),
            )
        };
        match node.lab {
            None => canvas.text(x + 2, y + 1, &fit(&title, inner), name_style),
            Some(l) => {
                let state = labs[l].state().to_owned();
                let room = inner.saturating_sub(state.chars().count() + 1);
                canvas.text(x + 2, y + 1, &fit(&title, room), name_style);
                canvas.text(
                    x + 2 + inner - state.chars().count(),
                    y + 1,
                    &state,
                    state_style,
                );
            }
        }
        let sub_style = if focus {
            Style::default().fg(Color::Black).bg(AQUA)
        } else {
            Style::default().fg(GRAY)
        };
        canvas.text(x + 2, y + 2, &fit(&subtitle, inner), sub_style);
        if let Some(tag) = &tag {
            let tag_style = if focus {
                Style::default().fg(Color::Black).bg(AQUA)
            } else {
                Style::default().fg(DIM)
            };
            canvas.text(x + 2, y + 3, &fit(tag, inner), tag_style);
        }
    }
    (canvas, origin)
}

// ---------------------------------------------------------------- app

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Sort {
    Tree,
    Name,
    State,
    Age,
}

impl Sort {
    fn next(self) -> Self {
        match self {
            Sort::Tree => Sort::Name,
            Sort::Name => Sort::State,
            Sort::State => Sort::Age,
            Sort::Age => Sort::Tree,
        }
    }
    fn name(self) -> &'static str {
        match self {
            Sort::Tree => "tree",
            Sort::Name => "name",
            Sort::State => "state",
            Sort::Age => "age",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Mode {
    Normal,
    Filter(String),
    Command(String),
    Message(String),
    Confirm(String),
    ConfirmRenew(String),
    Peek,
    Describe,
    Help,
    PreviewCommand,
    PreviewSummary,
    LoadPreview(String),
}

struct App {
    view: View,
    mode: Mode,
    sort: Sort,
    filter: String,
    labs: Vec<Lab>,
    history: HashMap<String, VecDeque<u64>>,
    last_bytes: HashMap<String, u64>,
    total: VecDeque<u64>,
    selected: Option<String>,
    table: TableState,
    scroll: u16,
    flash: Option<(String, Instant, bool)>,
    interval_ms: u64,
    quit: bool,
    agents: AgentsFeed,
    agents_table: TableState,
    overlay: crate::graphspec::Overlay,
    events: crate::relations::EventsFeed,
    relations: Vec<crate::wire::Edge>,
    show_relations: bool,
    preview: Option<PreviewState>,
    view_before_preview: View,
}

impl App {
    fn new(view: View, interval_ms: u64) -> Self {
        App {
            view,
            mode: Mode::Normal,
            sort: Sort::Tree,
            filter: String::new(),
            labs: Vec::new(),
            history: HashMap::new(),
            last_bytes: HashMap::new(),
            total: VecDeque::new(),
            selected: None,
            table: TableState::default(),
            scroll: 0,
            flash: None,
            interval_ms,
            quit: false,
            agents: AgentsFeed::default(),
            agents_table: TableState::default(),
            overlay: crate::graphspec::Overlay::default(),
            events: crate::relations::EventsFeed::default(),
            relations: Vec::new(),
            show_relations: false,
            preview: None,
            view_before_preview: View::Labs,
        }
    }

    /// The MODEL text for a lab: the manifest's resolved model + pick tag when the lab
    /// belongs to an active manifest, else the recorded/inferred model.
    fn display_model(&self, lab: &Lab) -> String {
        match overlay_info(&self.overlay, lab.name()) {
            Some(info) => resolved_text(info),
            None => lab.model(),
        }
    }

    fn apply(&mut self, probes: Vec<Probe>) {
        let mut total_delta = 0u64;
        let live: HashSet<String> = probes.iter().map(|p| p.entry.name.clone()).collect();
        for probe in &probes {
            let name = probe.entry.name.clone();
            let delta = match self.last_bytes.insert(name.clone(), probe.bytes_out) {
                Some(before) => probe.bytes_out.saturating_sub(before),
                None => 0,
            };
            total_delta += delta;
            let history = self.history.entry(name).or_default();
            history.push_back(delta);
            while history.len() > HISTORY {
                history.pop_front();
            }
        }
        self.history.retain(|name, _| live.contains(name));
        self.last_bytes.retain(|name, _| live.contains(name));
        self.total.push_back(total_delta);
        while self.total.len() > HISTORY * 2 {
            self.total.pop_front();
        }
        let live_names: Vec<&str> = probes.iter().map(|p| p.entry.name.as_str()).collect();
        self.overlay = crate::graphspec::overlay(&live_names, &crate::graphspec::load_all());
        let mut all = probes.clone();
        for info in &self.overlay.planned {
            all.push(planned_probe(info));
        }
        self.labs = arrange_with(&all, &self.history, &self.overlay);
        let names: Vec<String> = live_names.iter().map(|name| (*name).to_owned()).collect();
        self.events.sync(&names);
        self.relations = crate::relations::current_edges();
        self.reselect();
    }

    /// Rows currently shown in the table, after filter and sort.
    fn visible(&self) -> Vec<&Lab> {
        let needle = self.filter.to_lowercase();
        let mut rows: Vec<&Lab> = self
            .labs
            .iter()
            .filter(|lab| {
                needle.is_empty()
                    || [
                        lab.name(),
                        &lab.role,
                        lab.state(),
                        &lab.model(),
                        lab.parent.as_deref().unwrap_or(""),
                    ]
                    .iter()
                    .any(|field| field.to_lowercase().contains(&needle))
            })
            .collect();
        match self.sort {
            Sort::Tree => {}
            Sort::Name => rows.sort_by(|a, b| a.name().cmp(b.name())),
            Sort::State => {
                rows.sort_by(|a, b| a.state().cmp(b.state()).then(a.name().cmp(b.name())))
            }
            Sort::Age => rows.sort_by_key(|lab| std::cmp::Reverse(lab.probe.uptime_ms)),
        }
        rows
    }

    fn reselect(&mut self) {
        let names: Vec<String> = self.visible().iter().map(|l| l.name().to_owned()).collect();
        let index = self
            .selected
            .as_ref()
            .and_then(|name| names.iter().position(|n| n == name))
            .or_else(|| {
                self.table
                    .selected()
                    .map(|i| i.min(names.len().saturating_sub(1)))
            })
            .filter(|_| !names.is_empty())
            .or(if names.is_empty() { None } else { Some(0) });
        self.table.select(index);
        self.selected = index.map(|i| names[i].clone());
    }

    fn selected_lab(&self) -> Option<&Lab> {
        let name = self.selected.as_ref()?;
        self.labs.iter().find(|l| l.name() == name)
    }

    fn step(&mut self, delta: isize) {
        let names: Vec<String> = self.visible().iter().map(|l| l.name().to_owned()).collect();
        if names.is_empty() {
            return;
        }
        let current = self.table.selected().unwrap_or(0) as isize;
        let next = (current + delta).clamp(0, names.len() as isize - 1) as usize;
        self.table.select(Some(next));
        self.selected = Some(names[next].clone());
    }

    fn jump(&mut self, end: bool) {
        self.step(if end { isize::MAX / 2 } else { isize::MIN / 2 });
    }

    /// Moves along the graph: left to the parent, right to the first child.
    fn walk_graph(&mut self, to_parent: bool) {
        let Some(current) = self.selected_lab().cloned() else {
            return;
        };
        let target = if to_parent {
            current
                .parent
                .clone()
                .filter(|p| self.labs.iter().any(|l| l.name() == p))
        } else {
            self.labs
                .iter()
                .find(|l| l.parent.as_deref() == Some(current.name()))
                .map(|l| l.name().to_owned())
        };
        if let Some(name) = target {
            self.selected = Some(name);
            self.reselect();
        }
    }

    fn say(&mut self, text: impl Into<String>, error: bool) {
        self.flash = Some((text.into(), Instant::now(), error));
    }

    fn counts(&self) -> [(&'static str, usize); 4] {
        let count = |state: &str| self.labs.iter().filter(|l| l.state() == state).count();
        [
            ("working", count("working") + count("up")),
            ("asking", count("asking")),
            ("stalled", count("stalled")),
            ("gone", count("exited") + count("gone")),
        ]
    }

    fn run_command(&mut self, text: &str) {
        let mut words = text.split_whitespace();
        let Some(head) = words.next() else { return };
        match head {
            "q" | "q!" | "quit" | "exit" => self.quit = true,
            "stop" | "kill" => match words
                .next()
                .map(str::to_owned)
                .or_else(|| self.selected.clone())
            {
                Some(name) => self.mode = Mode::Confirm(name),
                None => self.say("no lab selected", true),
            },
            "attach" | "a" => self.attach_selected(words.next().map(str::to_owned)),
            "help" | "?" => self.mode = Mode::Help,
            other => match View::parse(other) {
                Some(view) => {
                    self.view = view;
                    self.reselect();
                }
                None => self.say(
                    format!("unknown command :{other}  (labs, graph, models, stop, attach, quit)"),
                    true,
                ),
            },
        }
    }

    fn attach_selected(&mut self, name: Option<String>) {
        let Some(name) = name.or_else(|| self.selected.clone()) else {
            return self.say("no lab selected", true);
        };
        let Some(lab) = self.labs.iter().find(|l| l.name() == name) else {
            return self.say(format!("no lab named {name}"), true);
        };
        match open_terminal_window(
            &["attach".into(), "-s".into(), lab.probe.entry.socket.clone()],
            None,
        ) {
            Ok(()) => self.say(
                format!("opened {name} in a new window (Ctrl-] detaches)"),
                false,
            ),
            Err(error) => self.say(format!("attach failed: {error:#}"), true),
        }
    }

    fn spawn_self(&mut self, args: &[&str], ok: String) {
        let result = env::current_exe()
            .map_err(anyhow::Error::from)
            .and_then(|exe| {
                Command::new(exe)
                    .args(args)
                    .stdin(std::process::Stdio::null())
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .spawn()
                    .map(|_| ())
                    .map_err(anyhow::Error::from)
            });
        match result {
            Ok(()) => self.say(ok, false),
            Err(error) => self.say(format!("failed: {error:#}"), true),
        }
    }

    fn key(&mut self, key: KeyEvent) {
        let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
        if ctrl && key.code == KeyCode::Char('c') {
            self.quit = true;
            return;
        }
        match self.mode.clone() {
            Mode::Filter(mut text) | Mode::Command(mut text) | Mode::Message(mut text) => {
                let rebuild = |mode: &Mode, text: String| match mode {
                    Mode::Filter(_) => Mode::Filter(text),
                    Mode::Command(_) => Mode::Command(text),
                    _ => Mode::Message(text),
                };
                match key.code {
                    KeyCode::Esc => {
                        if matches!(self.mode, Mode::Filter(_)) {
                            self.filter.clear();
                        }
                        self.mode = Mode::Normal;
                        self.reselect();
                    }
                    KeyCode::Enter => {
                        let mode = std::mem::replace(&mut self.mode, Mode::Normal);
                        match mode {
                            Mode::Filter(text) => self.filter = text,
                            Mode::Command(text) => self.run_command(&text),
                            Mode::Message(text) => {
                                if let (Some(name), false) =
                                    (self.selected.clone(), text.is_empty())
                                {
                                    self.spawn_self(
                                        &["send", "-n", &name, "--paced", "-e", &text],
                                        format!("sent to {name}"),
                                    );
                                }
                            }
                            _ => {}
                        }
                        self.reselect();
                    }
                    KeyCode::Backspace => {
                        text.pop();
                        self.mode = rebuild(&self.mode, text);
                        if let Mode::Filter(t) = &self.mode {
                            self.filter = t.clone();
                            self.reselect();
                        }
                    }
                    KeyCode::Char(c) if !ctrl => {
                        text.push(c);
                        self.mode = rebuild(&self.mode, text);
                        if let Mode::Filter(t) = &self.mode {
                            self.filter = t.clone();
                            self.reselect();
                        }
                    }
                    _ => {}
                }
            }
            Mode::Confirm(name) => {
                match key.code {
                    KeyCode::Char('y') | KeyCode::Char('Y') | KeyCode::Enter => {
                        self.spawn_self(&["stop", "-n", &name], format!("stopping {name}"));
                    }
                    _ => self.say("cancelled", false),
                }
                self.mode = Mode::Normal;
            }
            Mode::ConfirmRenew(name) => {
                match key.code {
                    KeyCode::Char('y') | KeyCode::Char('Y') | KeyCode::Enter => {
                        self.spawn_self(&["renew", "-n", &name], format!("renewing {name}"));
                    }
                    _ => self.say("cancelled", false),
                }
                self.mode = Mode::Normal;
            }
            Mode::LoadPreview(text) => self.load_prompt_key(text, key),
            Mode::PreviewCommand | Mode::PreviewSummary => {
                if matches!(key.code, KeyCode::Esc | KeyCode::Char('q') | KeyCode::Enter) {
                    self.mode = Mode::Normal;
                }
            }
            Mode::Peek | Mode::Describe | Mode::Help => match key.code {
                KeyCode::Esc | KeyCode::Char('q') | KeyCode::Enter
                    if !matches!(self.mode, Mode::Peek) || key.code != KeyCode::Enter =>
                {
                    self.mode = Mode::Normal;
                    self.scroll = 0;
                }
                KeyCode::Char('a') => self.attach_selected(None),
                KeyCode::Char('d') => self.mode = Mode::Describe,
                KeyCode::Char('m') => self.mode = Mode::Message(String::new()),
                KeyCode::Down | KeyCode::Char('j') => self.scroll = self.scroll.saturating_add(1),
                KeyCode::Up | KeyCode::Char('k') => self.scroll = self.scroll.saturating_sub(1),
                _ => {}
            },
            Mode::Normal => match key.code {
                _ if self.view == View::Preview && self.preview_key(key) => {}
                KeyCode::Char('p') => self.toggle_preview(),
                KeyCode::Char('P') => self.mode = Mode::LoadPreview(String::new()),
                KeyCode::Char('q') | KeyCode::Esc if self.filter.is_empty() => self.quit = true,
                KeyCode::Esc => {
                    self.filter.clear();
                    self.reselect();
                }
                KeyCode::Char(':') => self.mode = Mode::Command(String::new()),
                KeyCode::Char('/') => self.mode = Mode::Filter(self.filter.clone()),
                KeyCode::Char('?') => self.mode = Mode::Help,
                KeyCode::Enter | KeyCode::Char('l' | 'v' | 'd' | 'a' | 's' | 'm')
                    if self.view == View::Agents =>
                {
                    self.say(
                        "agents view is read-only: press 1 or :labs to act on a lab",
                        false,
                    )
                }
                KeyCode::Char('d') if ctrl => {
                    if let Some(name) = self.selected.clone() {
                        self.mode = Mode::Confirm(name);
                    }
                }
                KeyCode::Char('k') if ctrl => {
                    if let Some(name) = self.selected.clone() {
                        self.mode = Mode::Confirm(name);
                    }
                }
                KeyCode::Char('R') => {
                    if let Some(name) = self.selected.clone() {
                        self.mode = Mode::ConfirmRenew(name);
                    }
                }
                KeyCode::Char('d') => self.mode = Mode::Describe,
                KeyCode::Char('a') | KeyCode::Char('s') => self.attach_selected(None),
                KeyCode::Char('m') => {
                    if self.selected.is_some() {
                        self.mode = Mode::Message(String::new());
                    }
                }
                KeyCode::Enter | KeyCode::Char('l') | KeyCode::Char('v') => {
                    if self.selected.is_some() {
                        self.mode = Mode::Peek;
                        self.scroll = 0;
                    }
                }
                KeyCode::Char('o') => {
                    self.sort = self.sort.next();
                    self.reselect();
                }
                KeyCode::Down | KeyCode::Char('j') if self.view == View::Agents => {
                    self.step_agents(1)
                }
                KeyCode::Up | KeyCode::Char('k') if self.view == View::Agents => {
                    self.step_agents(-1)
                }
                KeyCode::Char('g') if self.view == View::Labs => self.view = View::Graph,
                KeyCode::Char('g') | KeyCode::Home => self.jump(false),
                KeyCode::Char('G') | KeyCode::End => self.jump(true),
                KeyCode::Tab => {
                    self.view = match self.view {
                        View::Labs => View::Graph,
                        View::Graph => View::Models,
                        View::Models => View::Agents,
                        View::Agents => View::Events,
                        View::Events => View::Labs,
                        View::Preview => View::Labs,
                    };
                }
                KeyCode::Char('1') => self.view = View::Labs,
                KeyCode::Char('2') => self.view = View::Graph,
                KeyCode::Char('3') => self.view = View::Models,
                KeyCode::Char('4') => self.view = View::Agents,
                KeyCode::Char('5') => self.view = View::Events,
                KeyCode::Char('r') if self.view == View::Graph => {
                    self.show_relations = !self.show_relations
                }
                KeyCode::Down | KeyCode::Char('j') => self.step(1),
                KeyCode::Up | KeyCode::Char('k') => self.step(-1),
                KeyCode::PageDown => self.step(10),
                KeyCode::PageUp => self.step(-10),
                KeyCode::Left | KeyCode::Char('h') if self.view == View::Graph => {
                    self.walk_graph(true)
                }
                KeyCode::Right if self.view == View::Graph => self.walk_graph(false),
                _ => {}
            },
        }
    }
}

// ---------------------------------------------------------------- drawing

fn key_hint<'a>(key: &'a str, text: &'a str) -> Line<'a> {
    Line::from(vec![
        Span::styled(
            format!("<{key}>"),
            Style::default().fg(PINK).add_modifier(Modifier::BOLD),
        ),
        Span::raw(" "),
        Span::styled(text.to_owned(), Style::default().fg(GRAY)),
    ])
}

fn draw(frame: &mut Frame, app: &mut App) {
    let area = frame.area();
    let prompt_rows = if matches!(
        app.mode,
        Mode::Filter(_) | Mode::Command(_) | Mode::Message(_) | Mode::LoadPreview(_)
    ) {
        3
    } else {
        0
    };
    let [header, prompt, main, crumbs] = Layout::vertical([
        Constraint::Length(6),
        Constraint::Length(prompt_rows),
        Constraint::Min(5),
        Constraint::Length(1),
    ])
    .areas(area);
    draw_header(frame, header, app);
    if prompt_rows > 0 {
        draw_prompt(frame, prompt, app);
    }
    match app.view {
        View::Labs => draw_labs(frame, main, app),
        View::Graph if app.show_relations => {
            let rows = (app.relations.len() as u16 + 2).clamp(3, 10);
            let [graph, relations] =
                Layout::vertical([Constraint::Min(8), Constraint::Length(rows)]).areas(main);
            draw_graph_view(frame, graph, app);
            draw_relations(frame, relations, app);
        }
        View::Graph => draw_graph_view(frame, main, app),
        View::Events => draw_events(frame, main, app),
        View::Models => draw_models(frame, main, app),
        View::Agents => draw_agents(frame, main, app),
        View::Preview => draw_preview_view(frame, main, app),
    }
    draw_crumbs(frame, crumbs, app);
    match app.mode {
        Mode::Peek => draw_peek(frame, area, app),
        Mode::Describe => draw_describe(frame, area, app),
        Mode::Help => draw_help(frame, area),
        Mode::PreviewCommand => draw_preview_command(frame, area, app),
        Mode::PreviewSummary => draw_preview_summary(frame, area, app),
        Mode::Confirm(ref name) => draw_confirm(frame, area, name),
        Mode::ConfirmRenew(ref name) => draw_confirm_renew(frame, area, name),
        _ => {}
    }
}

fn draw_header(frame: &mut Frame, area: Rect, app: &App) {
    let [info, hints, logo] = Layout::horizontal([
        Constraint::Percentage(38),
        Constraint::Min(30),
        Constraint::Length(23),
    ])
    .areas(area);
    let label = |key: &str, value: String| {
        Line::from(vec![
            Span::styled(
                format!("{key:<10}"),
                Style::default().fg(ORANGE).add_modifier(Modifier::BOLD),
            ),
            Span::styled(value, Style::default().fg(Color::White)),
        ])
    };
    let counts = app.counts();
    let dir = session::session_dir().display().to_string();
    let terminal = env::var("H1_TERMINAL").unwrap_or_else(|_| {
        if cfg!(target_os = "macos") {
            "ghostty".into()
        } else {
            "default".into()
        }
    });
    let lines = vec![
        label(
            "Sessions:",
            fit(&dir, (info.width as usize).saturating_sub(11)),
        ),
        label("Terminal:", terminal),
        label("Labs:", format!("{}", app.labs.len())),
        Line::from(vec![
            Span::styled(
                format!("{:<10}", "State:"),
                Style::default().fg(ORANGE).add_modifier(Modifier::BOLD),
            ),
            Span::styled(format!("● {} ", counts[0].1), Style::default().fg(GREEN)),
            Span::styled(format!("◆ {} ", counts[1].1), Style::default().fg(YELLOW)),
            Span::styled(format!("◌ {} ", counts[2].1), Style::default().fg(ORANGE)),
            Span::styled(format!("✕ {}", counts[3].1), Style::default().fg(RED)),
        ]),
        label(
            "Refresh:",
            format!("{} ms · sort {}", app.interval_ms, app.sort.name()),
        ),
        label("Version:", format!("h1 {}", env!("CARGO_PKG_VERSION"))),
    ];
    frame.render_widget(Paragraph::new(lines), info);

    let (left, right): (Vec<Line>, Vec<Line>) = match app.view {
        View::Labs => (
            vec![
                key_hint("enter", "Peek screen"),
                key_hint("d", "Describe"),
                key_hint("a", "Attach (new window)"),
                key_hint("m", "Message"),
                key_hint("ctrl-d", "Stop"),
            ],
            vec![
                key_hint("/", "Filter"),
                key_hint(":", "Command"),
                key_hint("o", "Sort"),
                key_hint("g", "Graph"),
                key_hint("?", "Help"),
            ],
        ),
        View::Graph => (
            vec![
                key_hint("enter", "Peek screen"),
                key_hint("d", "Describe"),
                key_hint("a", "Attach (new window)"),
                key_hint("m", "Message"),
                key_hint("ctrl-d", "Stop"),
            ],
            vec![
                key_hint("↑↓", "Prev/next lab"),
                key_hint("←→", "Parent/child"),
                key_hint("r", "Relations"),
                key_hint("tab", "Next view"),
                key_hint(":", "Command"),
                key_hint("?", "Help"),
            ],
        ),
        View::Agents => (
            vec![
                key_hint("1", "Labs"),
                key_hint("2", "Graph"),
                key_hint("3", "Models"),
                key_hint("4", "All agents"),
                key_hint("j k", "Move"),
            ],
            vec![
                key_hint("/", "Filter"),
                key_hint(":", "Command"),
                key_hint("tab", "Next view"),
                key_hint("?", "Help"),
                key_hint("q", "Quit"),
            ],
        ),
        View::Events => (
            vec![
                key_hint("1", "Labs"),
                key_hint("2", "Graph"),
                key_hint("5", "Events"),
            ],
            vec![
                key_hint(":", "Command"),
                key_hint("tab", "Next view"),
                key_hint("?", "Help"),
                key_hint("q", "Quit"),
            ],
        ),
        View::Preview => (
            vec![
                key_hint("enter", "Open command"),
                key_hint("u", "Would-up summary"),
                key_hint("↑↓ ←→", "Node / parent,child"),
                key_hint("P", "Load a file"),
            ],
            vec![
                key_hint("p", "Back"),
                key_hint("q", "Back"),
                key_hint(":", "Command"),
                key_hint("?", "Help"),
            ],
        ),
        View::Models => (
            vec![
                key_hint("1", "Labs"),
                key_hint("2", "Graph"),
                key_hint("3", "Models"),
                key_hint("4", "All agents"),
            ],
            vec![
                key_hint("/", "Filter"),
                key_hint(":", "Command"),
                key_hint("?", "Help"),
                key_hint("q", "Quit"),
            ],
        ),
    };
    let [a, b] =
        Layout::horizontal([Constraint::Percentage(55), Constraint::Percentage(45)]).areas(hints);
    frame.render_widget(Paragraph::new(left), a);
    frame.render_widget(Paragraph::new(right), b);

    let logo_lines = [
        r" _        _    ____  ",
        r"| |      / \  | __ ) ",
        r"| |     / _ \ |  _ \ ",
        r"| |___ / ___ \| |_) |",
        r"|_____/_/   \_\____/ ",
        r"   h1     ",
    ];
    let lines: Vec<Line> = logo_lines
        .iter()
        .enumerate()
        .map(|(i, l)| {
            Line::from(Span::styled(
                *l,
                Style::default().fg(if i == 5 { GRAY } else { ORANGE }),
            ))
        })
        .collect();
    frame.render_widget(Paragraph::new(lines), logo);
}

fn draw_prompt(frame: &mut Frame, area: Rect, app: &App) {
    let (symbol, text, color, hint) = match &app.mode {
        Mode::Filter(t) => ("/", t.as_str(), AQUA, ""),
        Mode::Command(t) => (
            ":",
            t.as_str(),
            ORANGE,
            "  labs · graph · models · stop [lab] · attach [lab] · quit",
        ),
        Mode::Message(t) => ("send>", t.as_str(), PINK, ""),
        Mode::LoadPreview(t) => (
            "preview>",
            t.as_str(),
            RED,
            "  path to a .yah or preview .json",
        ),
        _ => return,
    };
    let target = match &app.mode {
        Mode::Message(_) => format!(" → {} ", app.selected.clone().unwrap_or_default()),
        _ => String::new(),
    };
    let block = Block::bordered()
        .border_style(Style::default().fg(color))
        .title(Span::styled(target, Style::default().fg(color)));
    let line = Line::from(vec![
        Span::styled(
            format!("{symbol} "),
            Style::default().fg(color).add_modifier(Modifier::BOLD),
        ),
        Span::styled(text.to_owned(), Style::default().fg(Color::White)),
        Span::styled("█", Style::default().fg(color)),
        Span::styled(hint, Style::default().fg(DIM)),
    ]);
    frame.render_widget(Paragraph::new(line).block(block), area);
}

fn titled_block<'a>(view: &str, shown: usize, total: usize, filter: &str) -> Block<'a> {
    let mut spans = vec![
        Span::styled(" ", Style::default()),
        Span::styled(
            view.to_owned(),
            Style::default().fg(AQUA).add_modifier(Modifier::BOLD),
        ),
    ];
    if !filter.is_empty() {
        spans.push(Span::styled(
            format!("(/{filter})"),
            Style::default().fg(Color::White),
        ));
    } else {
        spans.push(Span::styled("(all)", Style::default().fg(Color::White)));
    }
    spans.push(Span::styled(
        format!("[{shown}"),
        Style::default().fg(Color::White),
    ));
    if shown != total {
        spans.push(Span::styled(format!("/{total}"), Style::default().fg(DIM)));
    }
    spans.push(Span::styled("] ", Style::default().fg(Color::White)));
    Block::bordered()
        .border_style(Style::default().fg(BLUE))
        .title(Line::from(spans))
        .title_alignment(Alignment::Center)
}

fn spark(history: &[u64], width: usize) -> String {
    let tail = &history[history.len().saturating_sub(width)..];
    let peak = tail.iter().copied().max().unwrap_or(0);
    let mut out = String::new();
    for _ in tail.len()..width {
        out.push(' ');
    }
    for value in tail {
        if *value == 0 || peak == 0 {
            out.push('·');
        } else {
            out.push(BARS[((*value * 7) / peak).min(7) as usize]);
        }
    }
    out
}

fn draw_labs(frame: &mut Frame, area: Rect, app: &mut App) {
    let rows_data: Vec<Lab> = app.visible().into_iter().cloned().collect();
    let total = app.labs.len();
    let wide = area.width >= 125;
    let medium = area.width >= 100;
    let mut header = vec!["NAME", "ROLE"];
    let mut widths = vec![Constraint::Min(22), Constraint::Length(9)];
    if medium {
        header.push("PARENT");
        widths.push(Constraint::Length(12));
    }
    header.extend(["STATE", "MODEL"]);
    widths.extend([Constraint::Length(9), Constraint::Min(34)]);
    if medium {
        header.push("ACTIVITY");
        widths.push(Constraint::Length(10));
    }
    header.extend(["QUIET", "AGE"]);
    widths.extend([Constraint::Length(8), Constraint::Length(8)]);
    if wide {
        header.extend(["PROGRAM", "CWD"]);
        widths.extend([Constraint::Length(8), Constraint::Min(18)]);
    }
    let head = Row::new(header.iter().map(|h| Cell::from(*h)))
        .style(
            Style::default()
                .fg(Color::White)
                .add_modifier(Modifier::BOLD),
        )
        .bottom_margin(0);
    let rows = rows_data.iter().map(|lab| {
        let color = state_color(lab.state());
        let tree = app.sort == Sort::Tree && app.filter.is_empty();
        let name = if tree {
            format!("{}{}", lab.prefix, lab.name())
        } else {
            lab.name().to_owned()
        };
        let mut cells = vec![
            Cell::from(name).style(Style::default().fg(AQUA)),
            Cell::from(lab.role.clone()).style(Style::default().fg(role_color(&lab.role))),
        ];
        if medium {
            cells.push(
                Cell::from(lab.parent.clone().unwrap_or_else(|| "-".into()))
                    .style(Style::default().fg(GRAY)),
            );
        }
        cells.push(
            Cell::from(format!("{} {}", state_glyph(lab.state()), lab.state()))
                .style(Style::default().fg(color)),
        );
        cells.push(Cell::from(app.display_model(lab)).style(Style::default().fg(Color::White)));
        if medium {
            cells.push(Cell::from(spark(&lab.history, 8)).style(Style::default().fg(GREEN)));
        }
        cells.push(Cell::from(human_duration(lab.probe.quiet_ms)).style(Style::default().fg(GRAY)));
        cells
            .push(Cell::from(human_duration(lab.probe.uptime_ms)).style(Style::default().fg(GRAY)));
        if wide {
            cells.push(Cell::from(lab.program()).style(Style::default().fg(GRAY)));
            cells.push(
                Cell::from(
                    lab.probe
                        .entry
                        .cwd
                        .clone()
                        .map(|c| tail_path(&c, 28))
                        .unwrap_or_default(),
                )
                .style(Style::default().fg(GRAY)),
            );
        }
        Row::new(cells)
    });
    let table = Table::new(rows, widths)
        .header(head)
        .block(titled_block("labs", rows_data.len(), total, &app.filter))
        .row_highlight_style(Style::default().fg(Color::Black).bg(AQUA))
        .column_spacing(2);
    frame.render_stateful_widget(table, area, &mut app.table);
    if rows_data.is_empty() {
        let note = if total == 0 {
            vec![
                Line::from("No labs are running.").alignment(Alignment::Center),
                Line::from(""),
                Line::from("h1 open -n mgr1 --role manager -- pi --provider muse --model muse --no-session")
                    .style(Style::default().fg(DIM))
                    .alignment(Alignment::Center),
            ]
        } else {
            vec![Line::from("No lab matches the filter.").alignment(Alignment::Center)]
        };
        let inner = Rect {
            x: area.x + 1,
            y: area.y + area.height / 2 - 1,
            width: area.width - 2,
            height: 3,
        };
        frame.render_widget(Paragraph::new(note).style(Style::default().fg(GRAY)), inner);
    }
}

fn tail_path(path: &str, width: usize) -> String {
    let count = path.chars().count();
    if count <= width {
        path.to_owned()
    } else {
        let tail: String = path.chars().skip(count - (width - 1)).collect();
        format!("…{tail}")
    }
}

fn draw_graph_view(frame: &mut Frame, area: Rect, app: &mut App) {
    let block = titled_block("graph", app.labs.len(), app.labs.len(), "");
    let inner = block.inner(area);
    frame.render_widget(block, area);
    if inner.height < 8 {
        return;
    }
    let [top, body] = Layout::vertical([Constraint::Length(5), Constraint::Min(3)]).areas(inner);

    // activity sparkline: output bytes per refresh, all labs together
    let [spark_area, legend_area] =
        Layout::horizontal([Constraint::Min(20), Constraint::Length(30)]).areas(top);
    let data: Vec<u64> = app.total.iter().copied().collect();
    let spark_block = Block::bordered()
        .border_style(Style::default().fg(DIM))
        .title(Span::styled(
            " activity · output per refresh ",
            Style::default().fg(GRAY),
        ));
    let spark_inner = spark_block.inner(spark_area);
    frame.render_widget(spark_block, spark_area);
    let keep = spark_inner.width as usize;
    let shown = &data[data.len().saturating_sub(keep)..];
    frame.render_widget(
        Sparkline::default()
            .data(shown.iter().copied())
            .style(Style::default().fg(GREEN)),
        spark_inner,
    );
    let counts = app.counts();
    let legend = vec![
        Line::from(Span::styled(
            format!("● working {}", counts[0].1),
            Style::default().fg(GREEN),
        )),
        Line::from(Span::styled(
            format!("◆ asking  {}", counts[1].1),
            Style::default().fg(YELLOW),
        )),
        Line::from(Span::styled(
            format!("◌ stalled {}", counts[2].1),
            Style::default().fg(ORANGE),
        )),
        Line::from(Span::styled(
            format!("✕ gone    {}", counts[3].1),
            Style::default().fg(RED),
        )),
    ];
    frame.render_widget(
        Paragraph::new(legend),
        Rect {
            x: legend_area.x + 2,
            ..legend_area
        },
    );

    let body = match app.overlay.header() {
        Some(text) => {
            let [head, rest] =
                Layout::vertical([Constraint::Length(1), Constraint::Min(3)]).areas(body);
            frame.render_widget(
                Paragraph::new(Span::styled(
                    format!(" {text}"),
                    Style::default().fg(AQUA).add_modifier(Modifier::BOLD),
                )),
                head,
            );
            rest
        }
        None => body,
    };
    let nodes = layout(&app.labs);
    let focus_lab = app
        .selected
        .as_ref()
        .and_then(|name| app.labs.iter().position(|l| l.name() == name));
    let focus = focus_lab.and_then(|lab| nodes.iter().position(|n| n.lab == Some(lab)));
    let (canvas, origin) = draw_graph(&app.labs, &nodes, focus, &app.overlay);
    // keep the focused node in view
    let (fx, fy) = focus.map(|f| origin[f]).unwrap_or((0, 0));
    let view_w = body.width as usize;
    let view_h = body.height as usize;
    let ox = (fx + NODE_W).saturating_sub(view_w);
    let oy = (fy + NODE_H_TALL).saturating_sub(view_h);
    let lines = canvas.lines();
    let shown: Vec<Line> = lines
        .into_iter()
        .skip(oy)
        .map(|line| clip_line(line, ox, view_w))
        .collect();
    frame.render_widget(Paragraph::new(shown), body);
    if app.labs.is_empty() {
        frame.render_widget(
            Paragraph::new(Line::from("Waiting for labs to open…").alignment(Alignment::Center))
                .style(Style::default().fg(GRAY)),
            Rect {
                y: body.y + 6.min(body.height.saturating_sub(1)),
                height: 1,
                ..body
            },
        );
    }
}

fn clip_line(line: Line<'static>, skip: usize, width: usize) -> Line<'static> {
    if skip == 0 {
        return line;
    }
    let mut to_skip = skip;
    let mut spans = Vec::new();
    let mut used = 0;
    for span in line.spans {
        let count = span.content.chars().count();
        if to_skip >= count {
            to_skip -= count;
            continue;
        }
        let text: String = span.content.chars().skip(to_skip).collect();
        to_skip = 0;
        used += text.chars().count();
        spans.push(Span::styled(text, span.style));
        if used >= width {
            break;
        }
    }
    Line::from(spans)
}

// ---------------------------------------------------------------- all agents (native scan)

/// The latest registry from the scanner (or from a file given with `--agents`) and when it arrived.
#[derive(Default)]
struct AgentsFeed {
    registry: Option<Registry>,
    updated: Option<Instant>,
    error: Option<String>,
    shown: usize,
}

impl AgentsFeed {
    fn set(&mut self, registry: Registry) {
        self.registry = Some(registry);
        self.updated = Some(Instant::now());
        self.error = None;
    }

    fn age(&self) -> Option<Duration> {
        self.updated.map(|at| at.elapsed())
    }
}

/// A registry from the given file, or a fresh scan of this machine.
fn scan_registry(file: &Option<PathBuf>, stalled_ms: u64) -> std::result::Result<Registry, String> {
    match file {
        Some(path) => load_registry_file(path).map_err(|error| format!("{error:#}")),
        None => Ok(agents::registry_now(agents::scan(&agents::ScanOptions {
            probe: true,
            stalled_ms,
        }))),
    }
}

fn load_registry_file(path: &Path) -> Result<Registry> {
    let bytes = fs::read(path).with_context(|| format!("failed to read {}", path.display()))?;
    serde_json::from_slice(&bytes)
        .with_context(|| format!("{} is not an agent registry", path.display()))
}

fn agent_status_color(status: &str) -> Color {
    match status {
        "working" | "up" => GREEN,
        "asking" => YELLOW,
        "stalled" => ORANGE,
        "exited" | "gone" | "dead" => RED,
        _ => GRAY,
    }
}

impl App {
    /// Rows of the agents view after filter and ordering: this session first, then people-started
    /// agents, then labs, each by kind and name.
    fn visible_agents(&self) -> Vec<AgentRec> {
        let needle = self.filter.to_lowercase();
        let mut rows: Vec<AgentRec> = self
            .agents
            .registry
            .as_ref()
            .map(|registry| registry.agents.clone())
            .unwrap_or_default()
            .into_iter()
            .filter(|agent| {
                needle.is_empty()
                    || [
                        &agent.kind,
                        &agent.name,
                        &agent.role,
                        &agent.status,
                        &agent.model,
                        &agent.cwd,
                        &agent.last,
                    ]
                    .iter()
                    .any(|field| {
                        field
                            .as_deref()
                            .unwrap_or("")
                            .to_lowercase()
                            .contains(&needle)
                    })
            })
            .collect();
        rows.sort_by_key(|a| (!a.this_session, a.managed, a.kind.clone(), a.name.clone()));
        rows
    }

    fn step_agents(&mut self, delta: isize) {
        let total = self.agents.shown;
        if total == 0 {
            return;
        }
        let current = self.agents_table.selected().unwrap_or(0) as isize;
        self.agents_table
            .select(Some((current + delta).clamp(0, total as isize - 1) as usize));
    }
}

/// The relations overlay under the graph (`r`): one line per declared edge.
fn draw_relations(frame: &mut Frame, area: Rect, app: &App) {
    let block = titled_block("relations", app.relations.len(), app.relations.len(), "");
    let inner = block.inner(area);
    frame.render_widget(block, area);
    let lines: Vec<Line> = if app.relations.is_empty() {
        vec![Line::from(Span::styled(
            "no relations (h1 relation add FROM KIND TO)",
            Style::default().fg(GRAY),
        ))]
    } else {
        app.relations
            .iter()
            .map(|edge| {
                Line::from(Span::styled(
                    crate::relations::edge_text(edge),
                    Style::default().fg(PURPLE),
                ))
            })
            .collect()
    };
    frame.render_widget(Paragraph::new(lines), inner);
}

/// The events pane (`:events`, `5`): the newest events of every running session.
fn draw_events(frame: &mut Frame, area: Rect, app: &App) {
    let block = titled_block("events", app.labs.len(), app.labs.len(), "");
    let inner = block.inner(area);
    frame.render_widget(block, area);
    let recent = app.events.recent(inner.height as usize);
    let lines: Vec<Line> = if recent.is_empty() {
        vec![Line::from(Span::styled(
            "no events yet (state changes of running sessions appear here)",
            Style::default().fg(GRAY),
        ))]
    } else {
        recent
            .into_iter()
            .map(|text| Line::from(Span::styled(text, Style::default().fg(Color::White))))
            .collect()
    };
    frame.render_widget(Paragraph::new(lines), inner);
}

fn draw_agents(frame: &mut Frame, area: Rect, app: &mut App) {
    let rows_data = app.visible_agents();
    let total = app
        .agents
        .registry
        .as_ref()
        .map(|r| r.agents.len())
        .unwrap_or(0);
    app.agents.shown = rows_data.len();
    if app.agents_table.selected().is_none() && !rows_data.is_empty() {
        app.agents_table.select(Some(0));
    }
    if let Some(selected) = app.agents_table.selected()
        && selected >= rows_data.len()
    {
        app.agents_table.select(rows_data.len().checked_sub(1));
    }
    let [table_area, note_area] =
        Layout::vertical([Constraint::Min(4), Constraint::Length(1)]).areas(area);
    let block = titled_block("agents", rows_data.len(), total, &app.filter);
    if app.agents.registry.is_none() {
        let inner = block.inner(table_area);
        frame.render_widget(block, table_area);
        let text = match &app.agents.error {
            Some(error) => format!("Could not read the agent registry: {error}"),
            None => "Scanning for agents…".to_owned(),
        };
        let rect = Rect {
            y: inner.y + inner.height / 2,
            height: 1.min(inner.height),
            ..inner
        };
        frame.render_widget(
            Paragraph::new(Line::from(text).alignment(Alignment::Center))
                .style(Style::default().fg(GRAY)),
            rect,
        );
        return;
    }
    let wide = table_area.width >= 130;
    let mut header = vec!["KIND", "NAME", "ROLE", "STATUS", "MODEL", "CTX", "UPTIME"];
    let mut widths = vec![
        Constraint::Length(8),
        Constraint::Min(20),
        Constraint::Length(24),
        Constraint::Length(9),
        Constraint::Min(18),
        Constraint::Length(11),
        Constraint::Length(8),
    ];
    if wide {
        header.extend(["CWD", "LAST ACTIVITY"]);
        widths.extend([Constraint::Length(24), Constraint::Min(30)]);
    }
    let head = Row::new(header.iter().map(|h| Cell::from(*h))).style(
        Style::default()
            .fg(Color::White)
            .add_modifier(Modifier::BOLD),
    );
    let rows = rows_data.iter().map(|agent| {
        let status = agent.status.clone().unwrap_or_default();
        let name = agent
            .name
            .clone()
            .or_else(|| agent.pid.map(|p| format!("pid {p}")))
            .unwrap_or_else(|| "-".into());
        let name_style = if agent.this_session {
            Style::default().fg(AQUA).add_modifier(Modifier::BOLD)
        } else {
            Style::default().fg(AQUA)
        };
        let mut cells = vec![
            Cell::from(agent.kind.clone().unwrap_or_else(|| "-".into()))
                .style(Style::default().fg(BLUE)),
            Cell::from(if agent.this_session {
                format!("◆ {name}")
            } else {
                name
            })
            .style(name_style),
            Cell::from(agent.role.clone().unwrap_or_else(|| "-".into()))
                .style(Style::default().fg(if agent.this_session { PINK } else { GRAY })),
            Cell::from(format!("{} {}", state_glyph(&status), status))
                .style(Style::default().fg(agent_status_color(&status))),
            Cell::from(agent.model.clone().unwrap_or_else(|| "-".into()))
                .style(Style::default().fg(Color::White)),
            Cell::from(agent.context.clone().unwrap_or_else(|| "-".into()))
                .style(Style::default().fg(GRAY)),
            Cell::from(agent.uptime.clone().unwrap_or_else(|| "-".into()))
                .style(Style::default().fg(GRAY)),
        ];
        if wide {
            cells.push(
                Cell::from(
                    agent
                        .cwd
                        .clone()
                        .map(|c| tail_path(&c, 24))
                        .unwrap_or_default(),
                )
                .style(Style::default().fg(GRAY)),
            );
            cells.push(
                Cell::from(agent.last.clone().unwrap_or_default()).style(Style::default().fg(DIM)),
            );
        }
        Row::new(cells)
    });
    let table = Table::new(rows, widths)
        .header(head)
        .block(block)
        .row_highlight_style(Style::default().fg(Color::Black).bg(AQUA))
        .column_spacing(2);
    frame.render_stateful_widget(table, table_area, &mut app.agents_table);
    let mut kinds: Vec<(String, usize)> = Vec::new();
    for agent in app.agents.registry.iter().flat_map(|r| r.agents.iter()) {
        let kind = agent.kind.clone().unwrap_or_else(|| "other".into());
        match kinds.iter_mut().find(|(k, _)| *k == kind) {
            Some((_, n)) => *n += 1,
            None => kinds.push((kind, 1)),
        }
    }
    kinds.sort();
    let counts = kinds
        .iter()
        .map(|(k, n)| format!("{k} {n}"))
        .collect::<Vec<_>>()
        .join(" · ");
    let age = app.agents.age().map(|d| d.as_secs()).unwrap_or(0);
    let stale = age > 30;
    let text = format!(
        " {counts}  |  scanned {age}s ago{}",
        if stale { "  (stale)" } else { "" }
    );
    frame.render_widget(
        Paragraph::new(Span::styled(
            text,
            Style::default().fg(if stale { ORANGE } else { DIM }),
        )),
        note_area,
    );
}

fn draw_models(frame: &mut Frame, area: Rect, app: &mut App) {
    let mut groups: Vec<(String, Vec<&Lab>)> = Vec::new();
    for lab in &app.labs {
        let model = lab.model();
        match groups.iter_mut().find(|(m, _)| *m == model) {
            Some((_, labs)) => labs.push(lab),
            None => groups.push((model, vec![lab])),
        }
    }
    groups.sort_by(|a, b| b.1.len().cmp(&a.1.len()).then(a.0.cmp(&b.0)));
    let needle = app.filter.to_lowercase();
    groups.retain(|(m, _)| needle.is_empty() || m.to_lowercase().contains(&needle));
    let head = Row::new(
        [
            "MODEL", "LABS", "MANAGERS", "WORKERS", "WORKING", "ASKING", "STALLED",
        ]
        .map(Cell::from),
    )
    .style(
        Style::default()
            .fg(Color::White)
            .add_modifier(Modifier::BOLD),
    );
    let rows = groups.iter().map(|(model, labs)| {
        let n = |f: &dyn Fn(&&Lab) -> bool| labs.iter().filter(|l| f(l)).count().to_string();
        let family = if model.starts_with("muse") {
            PINK
        } else if model.starts_with("opencode") {
            BLUE
        } else {
            Color::White
        };
        Row::new(vec![
            Cell::from(model.clone()).style(Style::default().fg(family)),
            Cell::from(labs.len().to_string()),
            Cell::from(n(&|l| is_lead(&l.role))),
            Cell::from(n(&|l| !is_lead(&l.role) && l.role != "lab")),
            Cell::from(n(&|l| matches!(l.state(), "working" | "up")))
                .style(Style::default().fg(GREEN)),
            Cell::from(n(&|l| l.state() == "asking")).style(Style::default().fg(YELLOW)),
            Cell::from(n(&|l| l.state() == "stalled")).style(Style::default().fg(ORANGE)),
        ])
    });
    let widths = [
        Constraint::Min(30),
        Constraint::Length(6),
        Constraint::Length(10),
        Constraint::Length(9),
        Constraint::Length(9),
        Constraint::Length(8),
        Constraint::Length(9),
    ];
    let table = Table::new(rows, widths)
        .header(head)
        .block(titled_block(
            "models",
            groups.len(),
            groups.len(),
            &app.filter,
        ))
        .column_spacing(2);
    frame.render_widget(table, area);
}

/// Colour of a role in the console. `builder`, `explorer` and `advisor` are the three-role team
/// (`lab-team`): the builder leads, the explorer reads, the advisor reviews.
fn role_color(role: &str) -> Color {
    match role {
        "manager" => PINK,
        "builder" => ORANGE,
        "explorer" => AQUA,
        "advisor" => PURPLE,
        "worker" => BLUE,
        _ => GRAY,
    }
}

/// Roles that lead other labs; the models view counts them under MANAGERS.
fn is_lead(role: &str) -> bool {
    matches!(role, "manager" | "builder")
}

#[cfg(test)]
mod overlay_tests {
    use super::*;

    #[test]
    fn lead_roles_count_as_managers() {
        assert!(is_lead("manager"));
        assert!(is_lead("builder"));
        assert!(!is_lead("worker"));
        assert!(!is_lead("commander"));
        assert!(!is_lead(""));
    }

    #[test]
    fn centered_clamps_and_centers_in_area() {
        let area = Rect {
            x: 0,
            y: 0,
            width: 20,
            height: 10,
        };
        let r = centered(area, 30, 4);
        assert_eq!((r.x, r.y, r.width, r.height), (0, 3, 20, 4));
        let r = centered(area, 10, 2);
        assert_eq!((r.x, r.y, r.width, r.height), (5, 4, 10, 2));
    }
}

fn draw_crumbs(frame: &mut Frame, area: Rect, app: &App) {
    let crumb = |text: &str, active: bool| {
        Span::styled(
            format!(" <{text}> "),
            if active {
                Style::default().fg(Color::Black).bg(ORANGE)
            } else {
                Style::default().fg(Color::Black).bg(AQUA)
            },
        )
    };
    let mut spans = vec![crumb(
        "labs",
        app.view == View::Labs && app.mode == Mode::Normal,
    )];
    if app.view != View::Labs {
        spans.push(Span::raw(" "));
        spans.push(crumb(app.view.name(), app.mode == Mode::Normal));
    }
    let overlay = match app.mode {
        Mode::Peek => Some("peek"),
        Mode::Describe => Some("describe"),
        Mode::Help => Some("help"),
        Mode::PreviewCommand => Some("command"),
        Mode::PreviewSummary => Some("would-up"),
        Mode::Confirm(_) => Some("stop?"),
        Mode::ConfirmRenew(_) => Some("renew?"),
        _ => None,
    };
    if let Some(name) = overlay {
        if let Some(lab) = &app.selected {
            spans.push(Span::raw(" "));
            spans.push(crumb(lab, false));
        }
        spans.push(Span::raw(" "));
        spans.push(crumb(name, true));
    }
    let left = Line::from(spans);
    frame.render_widget(Paragraph::new(left), area);
    if let Some((text, at, error)) = &app.flash
        && at.elapsed() < Duration::from_secs(6)
    {
        let color = if *error { RED } else { GREEN };
        let width = text.chars().count().min(area.width as usize / 2);
        let rect = Rect {
            x: area.x + area.width.saturating_sub(width as u16 + 1),
            width: width as u16,
            ..area
        };
        frame.render_widget(
            Paragraph::new(Span::styled(fit(text, width), Style::default().fg(color))),
            rect,
        );
    }
}

fn centered(area: Rect, width: u16, height: u16) -> Rect {
    let width = width.min(area.width);
    let height = height.min(area.height);
    Rect {
        x: area.x + (area.width - width) / 2,
        y: area.y + (area.height - height) / 2,
        width,
        height,
    }
}

fn draw_peek(frame: &mut Frame, area: Rect, app: &App) {
    let Some(lab) = app.selected_lab() else {
        return;
    };
    let rect = Rect {
        x: area.x,
        y: area.y + 6,
        width: area.width,
        height: area.height.saturating_sub(7),
    };
    frame.render_widget(Clear, rect);
    let title = Line::from(vec![
        Span::styled(" peek(", Style::default().fg(AQUA)),
        Span::styled(
            lab.name().to_owned(),
            Style::default()
                .fg(Color::White)
                .add_modifier(Modifier::BOLD),
        ),
        Span::styled(") ", Style::default().fg(AQUA)),
        Span::styled(
            format!("{} {} ", state_glyph(lab.state()), lab.state()),
            Style::default().fg(state_color(lab.state())),
        ),
    ]);
    let block = Block::bordered()
        .border_style(Style::default().fg(BLUE))
        .title(title)
        .title_alignment(Alignment::Center);
    let inner = block.inner(rect);
    let mut lines: Vec<&str> = lab.probe.screen.lines().map(str::trim_end).collect();
    while lines.last().is_some_and(|l| l.is_empty()) {
        lines.pop();
    }
    let start = lines.len().saturating_sub(inner.height as usize);
    let start = start.saturating_sub(app.scroll as usize);
    let text: Vec<Line> = lines
        .iter()
        .skip(start)
        .take(inner.height as usize)
        .map(|l| Line::from(l.to_string()))
        .collect();
    frame.render_widget(Paragraph::new(text).block(block), rect);
}

/// True only for env-NAME-shaped strings (`[A-Za-z_][A-Za-z0-9_]*`); anything value-shaped
/// (contains `=`, `-`, spaces, starts with a digit, ...) is dropped, never printed.
fn is_env_name(name: &str) -> bool {
    let mut chars = name.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

fn draw_describe(frame: &mut Frame, area: Rect, app: &App) {
    let Some(lab) = app.selected_lab() else {
        return;
    };
    let rect = Rect {
        x: area.x,
        y: area.y + 6,
        width: area.width,
        height: area.height.saturating_sub(7),
    };
    frame.render_widget(Clear, rect);
    let entry = &lab.probe.entry;
    let key = |k: &str| {
        Span::styled(
            format!("{k:<12}"),
            Style::default().fg(ORANGE).add_modifier(Modifier::BOLD),
        )
    };
    let line = |k: &str, v: String| {
        Line::from(vec![
            key(k),
            Span::styled(v, Style::default().fg(Color::White)),
        ])
    };
    let children: Vec<String> = app
        .labs
        .iter()
        .filter(|l| l.parent.as_deref() == Some(lab.name()))
        .map(|l| l.name().to_owned())
        .collect();
    let mut lines = vec![
        line("Name:", lab.name().to_owned()),
        line("Role:", lab.role.clone()),
        line(
            "Parent:",
            lab.parent
                .clone()
                .unwrap_or_else(|| "- (reports to the commander)".into()),
        ),
        line(
            "Children:",
            if children.is_empty() {
                "-".into()
            } else {
                children.join(", ")
            },
        ),
        line("Model:", app.display_model(lab)),
        line(
            "State:",
            format!(
                "{} (quiet for {})",
                lab.state(),
                human_duration(lab.probe.quiet_ms)
            ),
        ),
        line("Uptime:", human_duration(lab.probe.uptime_ms)),
        line("Command:", entry.command.join(" ")),
        line("Cwd:", entry.cwd.clone().unwrap_or_default()),
        line("Socket:", entry.socket.clone()),
        line("Host pid:", entry.pid.to_string()),
        line("Size:", format!("{}x{}", entry.cols, entry.rows)),
        line("Output:", format!("{} bytes", lab.probe.bytes_out)),
        line(
            "Title:",
            if lab.probe.window_title.is_empty() {
                entry.title.clone().unwrap_or_default()
            } else {
                lab.probe.window_title.clone()
            },
        ),
        Line::from(""),
        Line::from(Span::styled(
            "Screen (last lines)",
            Style::default().fg(AQUA).add_modifier(Modifier::BOLD),
        )),
    ];
    if let Some(info) = overlay_info(&app.overlay, lab.name()) {
        let pick = &info.node.pick;
        let via = match pick.rule.as_deref().filter(|rule| !rule.is_empty()) {
            Some(rule) => format!("{} · {}", pick.via, rule),
            None => pick.via.clone(),
        };
        let pick_text = if pick.reason.is_empty() {
            via
        } else {
            format!("{via} · {}", pick.reason)
        };
        let mut extra = vec![
            line("Team:", info.team.clone()),
            line("Run:", info.run.clone()),
            line("Harness:", info.node.harness.clone()),
            line("Requested:", info.node.requested_model.clone()),
            line("Pick:", pick_text),
            line(
                "Trace:",
                info.trace_dir.clone().unwrap_or_else(|| "-".into()),
            ),
        ];
        let secrets: Vec<String> = info
            .node
            .vault_env
            .iter()
            .filter(|name| is_env_name(name))
            .cloned()
            .collect();
        if !secrets.is_empty() {
            extra.push(line(
                "Secrets (names only):",
                format!(" {}", secrets.join(", ")),
            ));
        }
        lines.splice(5..5, extra);
    }
    let mut screen: Vec<&str> = lab
        .probe
        .screen
        .lines()
        .map(str::trim_end)
        .filter(|l| !l.is_empty())
        .collect();
    let keep = 14;
    screen.drain(..screen.len().saturating_sub(keep));
    lines.extend(
        screen
            .into_iter()
            .map(|l| Line::from(Span::styled(l.to_owned(), Style::default().fg(GRAY)))),
    );
    let title = Line::from(vec![
        Span::styled(" describe(", Style::default().fg(AQUA)),
        Span::styled(
            lab.name().to_owned(),
            Style::default()
                .fg(Color::White)
                .add_modifier(Modifier::BOLD),
        ),
        Span::styled(") ", Style::default().fg(AQUA)),
    ]);
    let block = Block::bordered()
        .border_style(Style::default().fg(BLUE))
        .title(title)
        .title_alignment(Alignment::Center);
    frame.render_widget(
        Paragraph::new(lines)
            .block(block)
            .scroll((app.scroll, 0))
            .wrap(Wrap { trim: false }),
        rect,
    );
}

fn draw_help(frame: &mut Frame, area: Rect) {
    let rect = centered(area, 74, 32);
    frame.render_widget(Clear, rect);
    let section = |t: &str| {
        Line::from(Span::styled(
            t.to_owned(),
            Style::default().fg(AQUA).add_modifier(Modifier::BOLD),
        ))
    };
    let row = |k: &str, d: &str| {
        Line::from(vec![
            Span::styled(
                format!("  {k:<14}"),
                Style::default().fg(PINK).add_modifier(Modifier::BOLD),
            ),
            Span::styled(d.to_owned(), Style::default().fg(Color::White)),
        ])
    };
    let lines = vec![
        section("Navigation"),
        row("j k ↑ ↓", "move the cursor"),
        row("g / G", "top / bottom of the table"),
        row(
            "tab  1 2 3 4 5",
            "labs / graph / models / all agents / events",
        ),
        row("r", "relations overlay under the graph"),
        row("← → (graph)", "jump to the parent / first child"),
        Line::from(""),
        section("Actions on the lab under the cursor"),
        row("enter  l", "peek at its live screen (esc to leave)"),
        row("d", "describe: role, parent, children, model, command"),
        row("a  s", "attach in a new terminal window (Ctrl-] detaches)"),
        row("m", "type a message into the lab (Enter sends)"),
        row("ctrl-d  ctrl-k", "stop the lab (asks first)"),
        row("R", "renew the lab (asks first)"),
        row(
            "P  p",
            "preview a .yah/.json (load a path) / toggle the preview view",
        ),
        row(
            "(preview)",
            "enter: command   u: would-up summary   q: back",
        ),
        Line::from(""),
        section("Filtering and commands"),
        row("/", "filter by name, role, state, model or parent"),
        row("o", "sort: tree, name, state, age"),
        row(":labs :graph", ":models :agents switch view"),
        row(
            ":stop [lab]",
            "stop a lab        :attach [lab]  attach in a window",
        ),
        row("esc", "clear filter / close overlay"),
        row("q  :q  ctrl-c", "quit"),
        Line::from(""),
        Line::from(Span::styled(
            "  Lab graph edges come from `open --parent`, or automatically from a manager's own opens.",
            Style::default().fg(GRAY),
        )),
    ];
    let block = Block::bordered()
        .border_style(Style::default().fg(BLUE))
        .title(Span::styled(" help ", Style::default().fg(AQUA)))
        .title_alignment(Alignment::Center);
    frame.render_widget(Paragraph::new(lines).block(block), rect);
}

fn draw_confirm(frame: &mut Frame, area: Rect, name: &str) {
    let rect = centered(area, 52, 5);
    frame.render_widget(Clear, rect);
    let block = Block::bordered()
        .border_style(Style::default().fg(RED))
        .title(Span::styled(" Stop ", Style::default().fg(RED)))
        .title_alignment(Alignment::Center);
    let lines = vec![
        Line::from(""),
        Line::from(vec![
            Span::raw("Stop lab "),
            Span::styled(
                name.to_owned(),
                Style::default().fg(AQUA).add_modifier(Modifier::BOLD),
            ),
            Span::raw("?"),
        ])
        .alignment(Alignment::Center),
        Line::from(Span::styled(
            "<y> stop    <any other key> cancel",
            Style::default().fg(GRAY),
        ))
        .alignment(Alignment::Center),
    ];
    frame.render_widget(Paragraph::new(lines).block(block), rect);
}

fn draw_confirm_renew(frame: &mut Frame, area: Rect, name: &str) {
    let rect = centered(area, 52, 5);
    frame.render_widget(Clear, rect);
    let block = Block::bordered()
        .border_style(Style::default().fg(GREEN))
        .title(Span::styled(" Renew ", Style::default().fg(GREEN)))
        .title_alignment(Alignment::Center);
    let lines = vec![
        Line::from(""),
        Line::from(vec![
            Span::raw("Renew lab "),
            Span::styled(
                name.to_owned(),
                Style::default().fg(AQUA).add_modifier(Modifier::BOLD),
            ),
            Span::raw("?"),
        ])
        .alignment(Alignment::Center),
        Line::from(Span::styled(
            "<y> renew    <any other key> cancel",
            Style::default().fg(GRAY),
        ))
        .alignment(Alignment::Center),
    ];
    frame.render_widget(Paragraph::new(lines).block(block), rect);
}

// ---------------------------------------------------------------- loops

fn tui(args: &ConsoleArgs, view: View) -> Result<()> {
    let interval = Duration::from_millis(args.interval_ms.max(200));
    let stalled_ms = args.stalled_ms;
    let (sender, receiver) =
        mpsc::channel::<(Vec<Probe>, Option<std::result::Result<Registry, String>>)>();
    let stop = Arc::new(AtomicBool::new(false));
    let agents_file = args.agents.clone();
    let poller = {
        let stop = stop.clone();
        thread::spawn(move || {
            let mut cycle: u64 = 0;
            while !stop.load(Ordering::Relaxed) {
                let started = Instant::now();
                let probes = probe_all(stalled_ms);
                // the all-agents scan costs a process listing and a few reads: every third refresh
                let registry = cycle
                    .is_multiple_of(3)
                    .then(|| scan_registry(&agents_file, stalled_ms));
                cycle += 1;
                if sender.send((probes, registry)).is_err() {
                    break;
                }
                while started.elapsed() < interval && !stop.load(Ordering::Relaxed) {
                    thread::sleep(Duration::from_millis(50));
                }
            }
        })
    };
    let mut app = App::new(view, args.interval_ms);
    if let Some(file) = &args.preview {
        app.load_preview(file);
    }
    let mut terminal = ratatui::init();
    let result = (|| -> Result<()> {
        let mut dirty = true;
        while !app.quit {
            while let Ok((probes, registry)) = receiver.try_recv() {
                app.apply(probes);
                match registry {
                    Some(Ok(registry)) => app.agents.set(registry),
                    Some(Err(error)) => app.agents.error = Some(error),
                    None => {}
                }
                dirty = true;
            }
            if app
                .flash
                .as_ref()
                .is_some_and(|(_, at, _)| at.elapsed() < Duration::from_millis(6100))
            {
                dirty = true;
            }
            if dirty {
                terminal.draw(|frame| draw(frame, &mut app))?;
                dirty = false;
            }
            if event::poll(Duration::from_millis(100))? {
                match event::read()? {
                    Event::Key(key) if key.kind == KeyEventKind::Press => {
                        app.key(key);
                        dirty = true;
                    }
                    Event::Resize(..) => dirty = true,
                    _ => {}
                }
            }
        }
        Ok(())
    })();
    ratatui::restore();
    stop.store(true, Ordering::Relaxed);
    let _ = poller.join();
    result
}

/// One frame as plain text, from a fresh look at the running sessions.
fn snapshot(args: &ConsoleArgs, view: View) -> Result<i32> {
    let mut app = App::new(view, args.interval_ms);
    let first = probe_all(args.stalled_ms);
    app.apply(first.clone());
    app.apply(first);
    if let Some(file) = &args.preview {
        app.load_preview(file);
        if app.preview.is_none() {
            return Err(anyhow!("cannot preview {file}"));
        }
    }
    match scan_registry(&args.agents, args.stalled_ms) {
        Ok(registry) => app.agents.set(registry),
        Err(error) => app.agents.error = Some(error),
    }
    println!("{}", render_text(&mut app, args.width, args.height)?);
    Ok(0)
}

fn render_text(app: &mut App, width: u16, height: u16) -> Result<String> {
    let mut terminal = Terminal::new(TestBackend::new(width, height))?;
    terminal.draw(|frame| draw(frame, app))?;
    let buffer = terminal.backend().buffer().clone();
    let mut out = String::new();
    for y in 0..buffer.area.height {
        let mut line = String::new();
        for x in 0..buffer.area.width {
            line.push_str(buffer[(x, y)].symbol());
        }
        out.push_str(line.trim_end());
        out.push('\n');
    }
    Ok(out.trim_end().to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn probe(
        name: &str,
        parent: Option<&str>,
        role: Option<&str>,
        state: &str,
        model: &[&str],
        started: u64,
    ) -> Probe {
        Probe {
            entry: session::Entry {
                name: name.into(),
                pid: 1,
                socket: format!("/s/{name}.sock"),
                command: model.iter().map(|s| s.to_string()).collect(),
                cwd: Some("/work/repo".into()),
                title: None,
                cols: 150,
                rows: 40,
                started_ms: started,
                role: role.map(Into::into),
                parent: parent.map(Into::into),
                model: None,
                brief: None,
                resume_log: None,
                new_cmd: None,
                ready_regex: None,
                auto_rearm: false,
                env_names: Vec::new(),
            },
            state: state.into(),
            screen: format!("{name} screen line\n"),
            quiet_ms: 1500,
            uptime_ms: 65_000,
            bytes_out: 100,
            window_title: String::new(),
        }
    }

    fn fleet() -> Vec<Probe> {
        let muse = ["pi", "--provider", "muse", "--model", "muse"];
        let oc = ["pi", "--model", "opencode-cli/opencode/gpt-6-luna"];
        vec![
            probe("mgr1", None, Some("manager"), "working", &muse, 1),
            probe("w1", Some("mgr1"), None, "working", &muse, 2),
            probe("w2", Some("mgr1"), None, "asking", &oc, 3),
            probe("mgr2", None, None, "stalled", &muse, 4),
            probe("w3", Some("mgr2"), None, "stalled", &muse, 5),
            probe("orphan", Some("vanished"), None, "working", &muse, 6),
        ]
    }

    #[test]
    fn arrange_builds_a_forest_with_roles_and_connectors() {
        let labs = arrange(&fleet(), &HashMap::new());
        let names: Vec<_> = labs.iter().map(|l| l.name().to_owned()).collect();
        assert_eq!(names, ["mgr1", "w1", "w2", "mgr2", "w3", "orphan"]);
        let role = |n: &str| labs.iter().find(|l| l.name() == n).unwrap().role.clone();
        assert_eq!(role("mgr1"), "manager");
        assert_eq!(role("mgr2"), "manager", "inferred from having children");
        assert_eq!(role("w1"), "worker");
        assert_eq!(
            role("orphan"),
            "worker",
            "a parent that is not running does not hide the lab"
        );
        assert_eq!(labs[1].prefix, "├─ ");
        assert_eq!(labs[2].prefix, "└─ ");
        assert_eq!(labs[1].depth, 1);
        // the orphan is a root: its parent is not in the registry
        assert_eq!(labs[5].depth, 0);
    }

    #[test]
    fn a_parent_cycle_does_not_loop_or_drop_labs() {
        let looped = vec![
            probe("a", Some("b"), None, "working", &["sh"], 1),
            probe("b", Some("a"), None, "working", &["sh"], 2),
        ];
        let labs = arrange(&looped, &HashMap::new());
        assert_eq!(labs.len(), 2);
    }

    #[test]
    fn layout_centres_a_parent_on_its_children() {
        let labs = arrange(&fleet(), &HashMap::new());
        let nodes = layout(&labs);
        assert_eq!(nodes[0].lab, None);
        assert_eq!(nodes[0].depth, 0);
        let find = |name: &str| {
            nodes
                .iter()
                .find(|n| n.lab.map(|l| labs[l].name() == name).unwrap_or(false))
                .unwrap()
        };
        assert_eq!(find("mgr1").depth, 1);
        assert_eq!(find("w1").depth, 2);
        let (a, b) = (find("w1").row, find("w2").row);
        assert!(a < b);
        assert_eq!(find("mgr1").row, (a + b) / 2 - (a + b) / 2 % 2);
    }

    #[test]
    fn team_roles_have_their_own_colours() {
        let roles = ["builder", "explorer", "advisor", "manager", "worker"];
        let colours: Vec<Color> = roles.iter().map(|r| role_color(r)).collect();
        for (i, a) in colours.iter().enumerate() {
            for b in &colours[i + 1..] {
                assert_ne!(a, b);
            }
        }
        assert_eq!(role_color("anything else"), GRAY);
        assert!(is_lead("builder") && is_lead("manager") && !is_lead("explorer"));
    }

    #[test]
    fn spark_scales_to_the_peak_and_marks_quiet_ticks() {
        assert_eq!(spark(&[0, 0, 0], 3), "···");
        assert_eq!(spark(&[1, 8], 4), "  ▁█");
        assert_eq!(spark(&[], 2), "  ");
    }

    #[test]
    fn labs_view_shows_hierarchy_models_and_states() {
        let mut app = App::new(View::Labs, 1000);
        app.apply(fleet());
        let text = render_text(&mut app, 170, 30).unwrap();
        for needle in [
            "labs(all)[6]",
            "mgr1",
            "├─ w1",
            "└─ w2",
            "manager",
            "muse/muse",
            "opencode-cli/opencode/gpt-6-luna",
            "◆ asking",
            "<enter>",
        ] {
            assert!(text.contains(needle), "missing {needle:?} in\n{text}");
        }
    }

    #[test]
    fn graph_view_draws_commander_nodes_and_edges() {
        let mut app = App::new(View::Graph, 1000);
        app.apply(fleet());
        let text = render_text(&mut app, 150, 40).unwrap();
        for needle in [
            "◆ commander",
            "● mgr1",
            "◆ w2",
            "◌ mgr2",
            "─▶",
            "graph(all)[6]",
        ] {
            assert!(text.contains(needle), "missing {needle:?} in\n{text}");
        }
    }

    #[test]
    fn relations_overlay_lists_edges_under_the_graph_and_events_pane_renders() {
        use crate::wire::{Edge, RelationKind};
        let mut app = App::new(View::Graph, 1000);
        app.apply(fleet());
        // `apply` asks live hosts; the fleet is fake, so set the edges the overlay shows.
        app.relations = vec![Edge {
            from: "mgr1".into(),
            kind: RelationKind::Supervises,
            to: "w2".into(),
            cascade: false,
        }];
        let before = render_text(&mut app, 150, 44).unwrap();
        assert!(!before.contains("mgr1 supervises w2"));
        app.show_relations = true;
        let text = render_text(&mut app, 150, 44).unwrap();
        assert!(
            text.contains("relations[1]") || text.contains("relations(all)[1]"),
            "{text}"
        );
        assert!(text.contains("mgr1 supervises w2"), "{text}");
        app.view = View::Events;
        let text = render_text(&mut app, 150, 44).unwrap();
        assert!(text.contains("events("), "{text}");
        assert!(text.contains("no events yet"), "{text}");
        assert_eq!(View::parse("events"), Some(View::Events));
    }

    #[test]
    fn graph_view_shows_full_model_and_tag_inside_manifest_node_boxes() {
        let manifest: crate::graphspec::Manifest = serde_json::from_str(
            r#"{ "version": 1, "run": "run-1", "team": "alpha", "source": "team.yah", "root": "dry-a", "created_ms": 1,
              "nodes": [
                { "name": "dry-a", "harness": "h", "role": "commander", "parent": null, "requested_model": "system-one", "model": "anthropic/claude-sonnet-5-5", "model_label": "sonnet", "pick": { "via": "system-one", "rule": "R3", "reason": "", "degraded_level": 0 }, "tools": [] },
                { "name": "dry-b", "harness": "h", "role": "worker", "parent": "dry-a", "requested_model": "system-one", "model": "anthropic/claude-haiku-5-5", "model_label": "haiku", "pick": { "via": "fallback", "rule": null, "reason": "", "degraded_level": 1 }, "tools": [] },
                { "name": "dry-c", "harness": "h", "role": "worker", "parent": "dry-a", "requested_model": "opus", "model": "anthropic/claude-opus-5-5", "model_label": "opus", "pick": { "via": "pinned", "rule": null, "reason": "", "degraded_level": 0 }, "tools": [] }
              ],
              "edges": [ { "from": "dry-a", "to": "dry-b", "kind": "parent" }, { "from": "dry-a", "to": "dry-c", "kind": "parent" } ] }"#,
        )
        .unwrap();
        let overlay = crate::graphspec::overlay(&["dry-a"], &[manifest]);
        assert_eq!(overlay.planned.len(), 2);
        let mut probes = vec![probe(
            "dry-a",
            None,
            Some("commander"),
            "working",
            &["cat"],
            1,
        )];
        for info in &overlay.planned {
            probes.push(planned_probe(info));
        }
        let labs = arrange_with(&probes, &HashMap::new(), &overlay);
        for width in [120u16, 150] {
            let mut app = App::new(View::Graph, 1000);
            app.labs = labs.clone();
            app.overlay = overlay.clone();
            let text = render_text(&mut app, width, 36).unwrap();
            for needle in [
                "claude-sonnet-5-5",
                "s1 R3",
                "claude-haiku-5-5",
                "fallback",
                "claude-opus-5-5",
                "pinned",
                "○ dry-b",
                "○ dry-c",
            ] {
                assert!(
                    text.contains(needle),
                    "width {width}: missing {needle:?} in\n{text}"
                );
            }
            assert!(
                !text.contains("anthropic/cla"),
                "width {width}: model still truncated in\n{text}"
            );
            for needle in ["claude-sonnet-5-5", "s1 R3", "fallback", "pinned"] {
                let line = text.lines().find(|l| l.contains(needle)).unwrap();
                assert!(
                    line.matches('│').count() >= 2,
                    "width {width}: {needle:?} not inside a node box: {line:?}"
                );
            }
        }
    }

    #[test]
    fn models_view_groups_labs_by_model() {
        let mut app = App::new(View::Models, 1000);
        app.apply(fleet());
        let text = render_text(&mut app, 150, 30).unwrap();
        assert!(text.contains("muse/muse"), "{text}");
        assert!(text.contains("opencode-cli/opencode/gpt-6-luna"), "{text}");
    }

    #[test]
    fn filter_and_sort_narrow_the_table_and_keep_the_selection_valid() {
        let mut app = App::new(View::Labs, 1000);
        app.apply(fleet());
        app.filter = "opencode".into();
        app.reselect();
        assert_eq!(app.visible().len(), 1);
        assert_eq!(app.selected.as_deref(), Some("w2"));
        app.filter = "nothing-matches".into();
        app.reselect();
        assert!(app.selected.is_none());
        app.filter.clear();
        app.sort = Sort::Name;
        app.reselect();
        assert_eq!(app.visible()[0].name(), "mgr1");
        assert!(app.selected.is_some());
    }

    #[test]
    fn keys_drive_modes() {
        let key = |c| KeyEvent::new(KeyCode::Char(c), KeyModifiers::NONE);
        let mut app = App::new(View::Labs, 1000);
        app.apply(fleet());
        app.key(key('j'));
        assert_eq!(app.selected.as_deref(), Some("w1"));
        app.key(key('/'));
        for c in "mgr".chars() {
            app.key(key(c));
        }
        app.key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
        assert_eq!(app.filter, "mgr");
        assert_eq!(
            app.visible().len(),
            5,
            "the filter also matches the parent column, so a manager's workers stay with it"
        );
        app.key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));
        assert!(app.filter.is_empty() && !app.quit);
        app.key(key(':'));
        for c in "graph".chars() {
            app.key(key(c));
        }
        app.key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
        assert_eq!(app.view, View::Graph);
        app.key(KeyEvent::new(KeyCode::Char('d'), KeyModifiers::CONTROL));
        assert!(matches!(app.mode, Mode::Confirm(_)));
        app.key(key('n'));
        assert_eq!(app.mode, Mode::Normal);
        app.key(key('q'));
        assert!(app.quit);
    }

    #[test]
    fn renew_key_asks_for_confirmation_and_renders_the_dialog() {
        let key = |c| KeyEvent::new(KeyCode::Char(c), KeyModifiers::NONE);
        let mut app = App::new(View::Labs, 1000);
        app.apply(fleet());
        assert_eq!(app.selected.as_deref(), Some("mgr1"));
        app.key(key('R'));
        assert!(
            matches!(app.mode, Mode::ConfirmRenew(ref n) if n == "mgr1"),
            "R must ask before renewing, got {:?}",
            app.mode
        );
        let text = render_text(&mut app, 120, 30).unwrap();
        assert!(
            text.contains("Renew lab") && text.contains("mgr1") && text.contains("<y> renew"),
            "{text}"
        );
        assert!(
            text.contains("renew?"),
            "crumb must name the renew overlay in\n{text}"
        );
        app.key(key('n'));
        assert_eq!(app.mode, Mode::Normal);
        app.key(key('?'));
        let text = render_text(&mut app, 120, 30).unwrap();
        assert!(
            text.contains("renew the lab (asks first)"),
            "help must list R in\n{text}"
        );
    }

    #[test]
    fn graph_walk_goes_to_parent_and_first_child() {
        let mut app = App::new(View::Graph, 1000);
        app.apply(fleet());
        app.selected = Some("w2".into());
        app.walk_graph(true);
        assert_eq!(app.selected.as_deref(), Some("mgr1"));
        app.walk_graph(false);
        assert_eq!(app.selected.as_deref(), Some("w1"));
    }

    #[test]
    fn the_empty_console_explains_how_to_open_a_lab() {
        let mut app = App::new(View::Labs, 1000);
        app.apply(Vec::new());
        let text = render_text(&mut app, 140, 24).unwrap();
        assert!(text.contains("No labs are running"), "{text}");
    }

    #[test]
    fn peek_and_describe_show_the_selected_screen() {
        let mut app = App::new(View::Labs, 1000);
        app.apply(fleet());
        app.mode = Mode::Peek;
        let text = render_text(&mut app, 120, 30).unwrap();
        assert!(
            text.contains("mgr1 screen line") && text.contains("peek("),
            "{text}"
        );
        app.mode = Mode::Describe;
        let text = render_text(&mut app, 120, 30).unwrap();
        assert!(
            text.contains("Children:") && text.contains("w1, w2"),
            "{text}"
        );
    }

    #[test]
    fn describe_shows_vault_env_names_only_and_omits_section_when_absent() {
        let manifest_with: crate::graphspec::Manifest = serde_json::from_str(
            r#"{"version":1,"run":"run-1","team":"default","source":"/tmp/x.yah","root":"mgr1","created_ms":1,"nodes":[{"name":"mgr1","harness":"mgr","role":"manager","parent":null,"requested_model":"system-one","model":"anthropic/claude-sonnet-5-5","model_label":"sonnet","pick":{"via":"system-one","rule":"R3","reason":"","degraded_level":0},"tools":[],"vault_env":["FLEET_TOKEN","OTHER_TOKEN","FLEET_TOKEN=abc123xyz","sk-abc123xyz"]}],"edges":[]}"#,
        )
        .unwrap();
        let mut app = App::new(View::Labs, 1000);
        app.apply(fleet());
        app.overlay = crate::graphspec::overlay(&["mgr1"], &[manifest_with]);
        app.mode = Mode::Describe;
        let text = render_text(&mut app, 150, 36).unwrap();
        assert!(text.contains("Secrets (names only):"), "{text}");
        assert!(
            text.contains("FLEET_TOKEN") && text.contains("OTHER_TOKEN"),
            "{text}"
        );
        assert!(
            !text.contains("abc123xyz"),
            "value-shaped entry leaked in\n{text}"
        );
        let manifest_without: crate::graphspec::Manifest = serde_json::from_str(
            r#"{"version":1,"run":"run-1","team":"default","source":"/tmp/x.yah","root":"mgr1","created_ms":1,"nodes":[{"name":"mgr1","harness":"mgr","role":"manager","parent":null,"requested_model":"system-one","model":"anthropic/claude-sonnet-5-5","model_label":"sonnet","pick":{"via":"system-one","rule":"R3","reason":"","degraded_level":0},"tools":[]}],"edges":[]}"#,
        )
        .unwrap();
        let mut app = App::new(View::Labs, 1000);
        app.apply(fleet());
        app.overlay = crate::graphspec::overlay(&["mgr1"], &[manifest_without]);
        app.mode = Mode::Describe;
        let text = render_text(&mut app, 150, 36).unwrap();
        assert!(
            text.contains("Team:") && text.contains("Children:"),
            "{text}"
        );
        assert!(
            !text.contains("Secrets"),
            "no vault_env must render unchanged in\n{text}"
        );
    }

    #[test]
    fn agents_view_lists_every_kind_with_this_session_first() {
        let registry: Registry = serde_json::from_str(
            r#"{"generatedAt":"2026-11-03T06:00:00Z","agents":[
              {"kind":"pi","name":"worker-a","role":"worker","pid":11,"model":"muse/muse","status":"working","context":"12%/400k","uptime":"3m","last":"created redline.ts","managed":true},
              {"kind":"claude","name":"f0cedc99","role":"this session (commander)","pid":22,"model":"claude-sonnet-5-5","status":"working","context":"210k tok","uptime":"4h","thisSession":true},
              {"kind":"opencode","name":"opencode-33","status":"idle"},
              {"kind":"claude","name":"aws","role":"worker","status":"stalled","last":"waiting","managed":true}
            ]}"#,
        )
        .unwrap();
        let mut app = App::new(View::Agents, 1000);
        app.agents.set(registry);
        let text = render_text(&mut app, 170, 24).unwrap();
        for needle in [
            "agents(all)[4]",
            "◆ f0cedc99",
            "worker-a",
            "opencode-33",
            "claude 2",
            "opencode 1",
            "pi 1",
            "created redline.ts",
            "scanned",
        ] {
            assert!(text.contains(needle), "missing {needle:?} in\n{text}");
        }
        let mine = text.lines().position(|l| l.contains("◆ f0cedc99")).unwrap();
        let standalone = text
            .lines()
            .position(|l| l.contains("opencode-33"))
            .unwrap();
        let lab = text.lines().position(|l| l.contains("worker-a")).unwrap();
        assert!(
            mine < standalone && standalone < lab,
            "this session, then people-started agents, then labs"
        );
        app.filter = "redline".into();
        assert_eq!(app.visible_agents().len(), 1);
    }

    #[test]
    fn agents_view_says_so_while_scanning_and_when_a_file_is_broken() {
        let mut app = App::new(View::Agents, 1000);
        let text = render_text(&mut app, 150, 20).unwrap();
        assert!(text.contains("Scanning for agents"), "{text}");
        let directory = tempfile::tempdir().unwrap();
        let broken = directory.path().join("broken.json");
        fs::write(&broken, "{ not json").unwrap();
        app.agents.error = scan_registry(&Some(broken), 8000).err();
        let text = render_text(&mut app, 150, 20).unwrap();
        assert!(text.contains("Could not read the agent registry"), "{text}");
        let good = directory.path().join("good.json");
        fs::write(
            &good,
            r#"{"agents":[{"kind":"codex","name":"c1","status":"idle"}]}"#,
        )
        .unwrap();
        assert_eq!(scan_registry(&Some(good), 8000).unwrap().agents.len(), 1);
    }

    #[test]
    fn view_switching_reaches_agents_by_key_tab_and_command() {
        let key = |c| KeyEvent::new(KeyCode::Char(c), KeyModifiers::NONE);
        let mut app = App::new(View::Labs, 1000);
        app.key(key('4'));
        assert_eq!(app.view, View::Agents);
        app.key(KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE));
        assert_eq!(app.view, View::Events);
        app.key(KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE));
        assert_eq!(app.view, View::Labs);
        app.key(key(':'));
        for c in "agents".chars() {
            app.key(key(c));
        }
        app.key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
        assert_eq!(app.view, View::Agents);
        app.key(KeyEvent::new(KeyCode::Char('d'), KeyModifiers::CONTROL));
        assert_eq!(
            app.mode,
            Mode::Normal,
            "the agents view cannot stop anything"
        );
    }
}
