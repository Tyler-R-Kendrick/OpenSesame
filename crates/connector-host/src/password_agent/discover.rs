//! Value-blind discovery projections.
use serde_json::{json, Value};
use std::collections::BTreeMap;
fn kind(item: &Value) -> String {
    item["category"]
        .as_str()
        .unwrap_or_default()
        .to_lowercase()
        .replace('_', "-")
}
fn words(text: &str) -> Vec<String> {
    text.to_lowercase()
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect()
}
fn distance(a: &str, b: &str) -> usize {
    let mut previous: Vec<usize> = (0..=b.len()).collect();
    for (i, x) in a.bytes().enumerate() {
        let mut current = vec![i + 1];
        for (j, y) in b.bytes().enumerate() {
            current.push(
                (previous[j + 1] + 1)
                    .min(current[j] + 1)
                    .min(previous[j] + usize::from(x != y)),
            );
        }
        previous = current;
    }
    previous[b.len()]
}
fn closeness(query: &str, title: &str) -> f64 {
    let terms = words(query);
    let candidates = words(title);
    if terms.is_empty() {
        return 0.0;
    }
    terms
        .iter()
        .map(|term| {
            candidates
                .iter()
                .map(|word| {
                    if word.contains(term) || (word.len() >= 3 && term.contains(word)) {
                        1.0
                    } else {
                        1.0 - numeric(distance(term, word)) / numeric(term.len().max(word.len()))
                    }
                })
                .fold(0.0, f64::max)
        })
        .sum::<f64>()
        / numeric(terms.len())
}
fn title_matches(item: &Value, terms: &[String]) -> bool {
    let title = item["title"].as_str().unwrap_or_default().to_lowercase();
    terms.iter().all(|term| title.contains(term))
}
fn suggestions(items: &[Value], query: &str) -> Vec<usize> {
    let mut scores: Vec<_> = items
        .iter()
        .enumerate()
        .map(|(i, item)| {
            (
                i,
                closeness(query, item["title"].as_str().unwrap_or_default()),
            )
        })
        .filter(|(_, score)| *score >= super::policy::policy().suggestion_threshold)
        .collect();
    scores.sort_by(|a, b| {
        b.1.total_cmp(&a.1)
            .then_with(|| compare_title(&items[a.0]["title"], &items[b.0]["title"]))
    });
    scores
        .into_iter()
        .take(super::policy::policy().suggestion_limit)
        .map(|(i, _)| i)
        .collect()
}
#[must_use]
pub fn selection(items: &[Value], queries: &[String]) -> Vec<SearchSelection> {
    let mut unique = Vec::new();
    for query in queries {
        if unique.iter().any(|(q, _, _)| q == query) {
            continue;
        }
        let terms: Vec<_> = query.split_whitespace().map(str::to_lowercase).collect();
        let matches: Vec<_> = items
            .iter()
            .enumerate()
            .filter(|(_, item)| title_matches(item, &terms))
            .map(|(i, _)| i)
            .collect();
        let suggested = if matches.is_empty() {
            suggestions(items, query)
        } else {
            Vec::new()
        };
        unique.push((query.clone(), matches, suggested));
    }
    unique
}
fn field_secret(item: &Value, field: &Value) -> Option<Value> {
    if field["type"] != "CONCEALED" && field["purpose"] != "PASSWORD" {
        return None;
    }
    let reference = field["reference"]
        .as_str()
        .filter(|r| r.starts_with("op://"))?;
    Some(
        json!({"ref":reference,"title":item["title"].as_str().unwrap_or_default(),"kind":kind(item)}),
    )
}
fn item_secrets(item: &Value) -> Vec<Value> {
    item["fields"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|field| field_secret(item, field))
        .collect()
}
fn selected_secrets(indices: &[usize], listed: &[Value], details: &[Value]) -> Vec<Value> {
    let ids: Vec<_> = indices.iter().map(|index| &listed[*index]["id"]).collect();
    details
        .iter()
        .filter(|item| ids.contains(&&item["id"]))
        .flat_map(item_secrets)
        .collect()
}
fn add_match(matches: &mut BTreeMap<String, Value>, mut value: Value, query: &str, multiple: bool) {
    let reference = value["ref"].as_str().unwrap_or_default().to_owned();
    if multiple {
        value["queries"] = json!([]);
    }
    let entry = matches.entry(reference).or_insert(value);
    if let Some(queries) = entry["queries"].as_array_mut() {
        queries.push(json!(query));
    }
}
#[must_use]
pub fn find(listed: &[Value], details: &[Value], queries: &[String]) -> Value {
    let searches = selection(listed, queries);
    let mut matches = BTreeMap::new();
    let mut suggestions = Vec::new();
    for (query, selected, suggested) in &searches {
        for value in selected_secrets(selected, listed, details) {
            add_match(&mut matches, value, query, searches.len() > 1);
        }
        for mut value in selected_secrets(suggested, listed, details) {
            value["query"] = json!(query);
            suggestions.push(value);
        }
    }
    let mut output = json!({"matches":matches.into_values().collect::<Vec<_>>()});
    if !suggestions.is_empty() {
        output["suggestions"] = json!(suggestions);
    }
    output
}
fn field_metadata(field: &Value) -> Value {
    let mut value = json!({"label":field["label"].as_str().or_else(||field["id"].as_str()).unwrap_or_default(),"type":field["type"].as_str().unwrap_or_default().to_lowercase()});
    for (from, to) in [("purpose", "purpose"), ("reference", "ref")] {
        if let Some(text) = field[from].as_str() {
            value[to] = json!(if from == "purpose" {
                text.to_lowercase()
            } else {
                text.into()
            });
        }
    }
    if let Some(section) = field["section"]["label"].as_str() {
        value["section"] = json!(section);
    }
    value
}
fn safe_url(href: &str) -> Option<String> {
    let url = url::Url::parse(href).ok()?;
    (matches!(url.scheme(), "https" | "http") && url.host_str().is_some())
        .then(|| url.origin().ascii_serialization())
}
fn item_metadata(item: &Value) -> Value {
    let fields: Vec<_> = item["fields"]
        .as_array()
        .into_iter()
        .flatten()
        .map(field_metadata)
        .collect();
    let mut tags: Vec<_> = item["tags"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect();
    tags.sort_unstable();
    let urls: Vec<_> = item["urls"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|u| u["href"].as_str())
        .filter_map(safe_url)
        .collect();
    let mut value = json!({"id":item["id"].as_str().unwrap_or_default(),"title":item["title"].as_str().unwrap_or_default(),"vault":item["vault"]["name"].as_str().unwrap_or_default(),"kind":kind(item),"tags":tags,"urls":urls,"fields":fields});
    for (from, to) in [("created_at", "createdAt"), ("updated_at", "updatedAt")] {
        if let Some(text) = item[from].as_str() {
            value[to] = json!(text);
        }
    }
    value
}
#[must_use]
pub fn inventory(items: &[Value]) -> Vec<Value> {
    let mut projected: Vec<_> = items.iter().map(item_metadata).collect();
    projected.sort_by(|a, b| {
        a["vault"]
            .as_str()
            .cmp(&b["vault"].as_str())
            .then_with(|| compare_title(&a["title"], &b["title"]))
    });
    projected
}
#[must_use]
pub fn audit(items: &[Value], cutoff: &str) -> Value {
    let raw_items = items;
    let items = inventory(items);
    let mut titles: BTreeMap<String, Vec<Value>> = BTreeMap::new();
    for item in &items {
        titles
            .entry(item["title"].as_str().unwrap_or_default().to_lowercase())
            .or_default()
            .push(json!({"id":item["id"].as_str().unwrap_or_default(),"title":item["title"].as_str().unwrap_or_default()}));
    }
    let tagged = items
        .iter()
        .filter(|i| i["tags"].as_array().is_some_and(|t| !t.is_empty()))
        .count();
    json!({"summary":{"items":items.len(),"tagged":tagged,"untagged":items.len()-tagged},"duplicateTitles":titles.into_values().filter(|g|g.len()>1).map(|g|json!({"title":g[0]["title"],"items":g})).collect::<Vec<_>>(),"untaggedMachineCredentials":items.iter().filter(|i| i["tags"].as_array().is_some_and(Vec::is_empty) && super::policy::policy().machine_kinds.iter().any(|kind|kind==i["kind"].as_str().unwrap_or_default())).map(|i|json!({"id":i["id"],"title":i["title"],"kind":i["kind"]})).collect::<Vec<_>>(),"oldLogins":items.iter().filter(|i|i["kind"]=="login" && i["updatedAt"].as_str().is_some_and(|t|t<cutoff)).map(|i|json!({"id":i["id"],"title":i["title"],"updatedAt":i["updatedAt"]})).collect::<Vec<_>>(),"urlsToReview":raw_items.iter().filter_map(|i|{let urls:Vec<_>=i["urls"].as_array().into_iter().flatten().filter_map(|u|u["href"].as_str()).filter(|u|super::policy::policy().transient_url_terms.iter().any(|word|u.to_lowercase().contains(word))).filter_map(safe_url).collect(); if urls.is_empty(){None}else{Some(json!({"id":i["id"].as_str().unwrap_or_default(),"title":i["title"].as_str().unwrap_or_default(),"urls":urls,"reason":"transient-url"}))}}).collect::<Vec<_>>()})
}

fn compare_title(a: &Value, b: &Value) -> std::cmp::Ordering {
    let a = a.as_str().unwrap_or_default();
    let b = b.as_str().unwrap_or_default();
    a.to_lowercase()
        .cmp(&b.to_lowercase())
        .then_with(|| b.cmp(a))
}

fn numeric(length: usize) -> f64 {
    f64::from(u32::try_from(length).unwrap_or(u32::MAX))
}
pub type SearchSelection = (String, Vec<usize>, Vec<usize>);
