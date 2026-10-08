//! Local sealed-store browser (ratatui). No Host provider catalog.

use std::path::Path;

use opensesame_sealed_store::list_names;

pub fn run(path: Option<&Path>, tomb: Option<&str>) -> anyhow::Result<()> {
    let root = crate::store::resolve_root(path, tomb)?;
    let names = list_names(&root, "")?;
    run_tui(&root, &names)
}

fn run_tui(store: &Path, names: &[String]) -> anyhow::Result<()> {
    use crossterm::{
        event::{self, Event, KeyCode, KeyEventKind},
        execute,
        terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
    };
    use ratatui::{backend::CrosstermBackend, Terminal};
    use std::io::stdout;

    enable_raw_mode()?;
    let mut output = stdout();
    execute!(output, EnterAlternateScreen)?;
    let mut terminal = Terminal::new(CrosstermBackend::new(output))?;
    let mut selected = 0usize;
    let result = (|| -> anyhow::Result<()> {
        loop {
            terminal.draw(|frame| draw(frame, store, names, selected))?;
            if !event::poll(std::time::Duration::from_millis(250))? {
                continue;
            }
            let Event::Key(key) = event::read()? else {
                continue;
            };
            if key.kind != KeyEventKind::Press {
                continue;
            }
            match key.code {
                KeyCode::Char('q') | KeyCode::Esc => break,
                KeyCode::Down | KeyCode::Char('j') if selected + 1 < names.len() => {
                    selected += 1;
                }
                KeyCode::Up | KeyCode::Char('k') if selected > 0 => {
                    selected -= 1;
                }
                _ => {}
            }
        }
        Ok(())
    })();
    disable_raw_mode()?;
    execute!(terminal.backend_mut(), LeaveAlternateScreen)?;
    terminal.show_cursor()?;
    result
}

fn draw(frame: &mut ratatui::Frame<'_>, store: &Path, names: &[String], selected: usize) {
    use ratatui::{
        layout::{Constraint, Layout},
        style::{Color, Modifier, Style},
        widgets::{Block, Borders, List, ListItem, Paragraph},
    };
    let [header, body, footer] = Layout::vertical([
        Constraint::Length(3),
        Constraint::Min(4),
        Constraint::Length(2),
    ])
    .areas(frame.area());
    frame.render_widget(
        Paragraph::new(format!("Sealed store: {}", store.display()))
            .style(Style::default().fg(Color::Cyan))
            .block(Block::default().borders(Borders::ALL)),
        header,
    );
    let items: Vec<ListItem<'_>> = names
        .iter()
        .enumerate()
        .map(|(index, name)| {
            let style = if index == selected {
                Style::default().add_modifier(Modifier::REVERSED)
            } else {
                Style::default()
            };
            ListItem::new(name.as_str()).style(style)
        })
        .collect();
    frame.render_widget(
        List::new(items).block(Block::default().title("Entries").borders(Borders::ALL)),
        body,
    );
    frame.render_widget(
        Paragraph::new("j/k: move · q or Esc: quit · names only, never values"),
        footer,
    );
}
