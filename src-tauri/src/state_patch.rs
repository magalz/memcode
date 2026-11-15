use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum StatePatch {
    Replace { value: Value },
    Object { set: Vec<(String, StatePatch)>, remove: Vec<String> },
    Array { length: usize, set: Vec<(usize, StatePatch)> },
}

/// Compare JSON state without putting unchanged conversation history on the wire.
pub fn difference(previous: &Value, next: &Value) -> Option<StatePatch> {
    if previous == next {
        return None;
    }
    Some(match (previous, next) {
        (Value::Object(old), Value::Object(new)) => StatePatch::Object {
            set: new.iter().filter_map(|(key, value)| {
                let patch = old.get(key).map_or_else(
                    || Some(StatePatch::Replace { value: value.clone() }),
                    |previous| difference(previous, value),
                );
                patch.map(|patch| (key.clone(), patch))
            }).collect(),
            remove: old.keys().filter(|key| !new.contains_key(*key)).cloned().collect(),
        },
        (Value::Array(old), Value::Array(new)) => StatePatch::Array {
            length: new.len(),
            set: new.iter().enumerate().filter_map(|(index, value)| {
                let patch = old.get(index).map_or_else(
                    || Some(StatePatch::Replace { value: value.clone() }),
                    |previous| difference(previous, value),
                );
                patch.map(|patch| (index, patch))
            }).collect(),
        },
        _ => StatePatch::Replace { value: next.clone() },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_streamed_message_does_not_resend_large_unchanged_history() {
        let old = json!({"tasks":[{"id":"story","messages":[
            {"text":"old context ".repeat(100_000)}, {"text":"Hello"}
        ]}],"project":"local"});
        let mut next = old.clone();
        next["tasks"][0]["messages"][1]["text"] = json!("Hello world");
        let patch = difference(&old, &next).unwrap();
        let bytes = serde_json::to_vec(&patch).unwrap();
        assert!(bytes.len() < 400, "One text update must not resend the 1MB history");
        assert!(difference(&next, &next).is_none());
    }

    #[test]
    fn deletion_append_and_type_changes_are_explicit() {
        let old = json!({"gone":true,"list":[1,2],"value":null});
        let next = json!({"list":[1,3,4],"value":{"__proto__":5}});
        assert_eq!(serde_json::to_value(difference(&old, &next).unwrap()).unwrap(), json!({
            "kind":"object","remove":["gone"],"set":[
                ["list",{"kind":"array","length":3,"set":[
                    [1,{"kind":"replace","value":3}], [2,{"kind":"replace","value":4}]
                ]}],
                ["value",{"kind":"replace","value":{"__proto__":5}}]
            ]
        }));
    }
}
