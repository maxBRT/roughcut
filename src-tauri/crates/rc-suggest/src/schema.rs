//! A small JSON Schema validator for the keywords the embedded answer schema uses:
//! `type`, `properties`, `required`, `additionalProperties: false`, `items`, `enum`,
//! `minimum`, `minLength` and `maxLength`. A schema keyword outside that list is reported
//! as a validation error, so the schema can never silently go unchecked.

use serde_json::Value;

const SUPPORTED: &[&str] = &[
    "type",
    "properties",
    "required",
    "additionalProperties",
    "items",
    "enum",
    "minimum",
    "minLength",
    "maxLength",
];

/// Checks `value` against `schema`. On failure, the first problem found, with its JSON path.
pub fn validate(schema: &Value, value: &Value) -> Result<(), String> {
    check(schema, value, "$")
}

fn is_integer(v: &Value) -> bool {
    v.is_i64()
        || v.is_u64()
        || v.as_f64()
            .is_some_and(|f| f.fract() == 0.0 && f.is_finite())
}

fn check(schema: &Value, value: &Value, path: &str) -> Result<(), String> {
    let Some(obj) = schema.as_object() else {
        return Err(format!("{path}: schema is not an object"));
    };
    if let Some(k) = obj.keys().find(|k| !SUPPORTED.contains(&k.as_str())) {
        return Err(format!("{path}: unsupported schema keyword {k:?}"));
    }
    if let Some(t) = obj.get("type").and_then(Value::as_str) {
        let ok = match t {
            "object" => value.is_object(),
            "array" => value.is_array(),
            "string" => value.is_string(),
            "integer" => is_integer(value),
            "number" => value.is_number(),
            "boolean" => value.is_boolean(),
            "null" => value.is_null(),
            other => return Err(format!("{path}: unsupported type {other:?}")),
        };
        if !ok {
            return Err(format!("{path}: expected {t}"));
        }
    }
    if let Some(options) = obj.get("enum").and_then(Value::as_array)
        && !options.contains(value)
    {
        return Err(format!(
            "{path}: {value} is not one of {}",
            Value::Array(options.clone())
        ));
    }
    if let (Some(min), Some(n)) = (obj.get("minimum").and_then(Value::as_f64), value.as_f64())
        && n < min
    {
        return Err(format!("{path}: {n} is below the minimum {min}"));
    }
    if let Some(s) = value.as_str() {
        let len = s.chars().count() as u64;
        if let Some(min) = obj.get("minLength").and_then(Value::as_u64)
            && len < min
        {
            return Err(format!("{path}: shorter than {min} characters"));
        }
        if let Some(max) = obj.get("maxLength").and_then(Value::as_u64)
            && len > max
        {
            return Err(format!("{path}: longer than {max} characters"));
        }
    }
    if let Some(map) = value.as_object() {
        let props = obj.get("properties").and_then(Value::as_object);
        if let Some(required) = obj.get("required").and_then(Value::as_array) {
            for r in required.iter().filter_map(Value::as_str) {
                if !map.contains_key(r) {
                    return Err(format!("{path}: missing required field {r:?}"));
                }
            }
        }
        for (k, v) in map {
            match props.and_then(|p| p.get(k)) {
                Some(sub) => check(sub, v, &format!("{path}.{k}"))?,
                None => {
                    if obj.get("additionalProperties") == Some(&Value::Bool(false)) {
                        return Err(format!("{path}: unexpected field {k:?}"));
                    }
                }
            }
        }
    }
    if let (Some(items), Some(arr)) = (obj.get("items"), value.as_array()) {
        for (i, v) in arr.iter().enumerate() {
            check(items, v, &format!("{path}[{i}]"))?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::request::ANSWER_SCHEMA;
    use serde_json::json;

    fn schema() -> Value {
        serde_json::from_str(ANSWER_SCHEMA).unwrap()
    }

    #[test]
    fn accepts_a_valid_answer() {
        let v = json!({"suggestions": [
            {"kind": "retake", "first_utterance": 4, "last_utterance": 5, "quote": "So the", "reason": "Repeated line", "keep_utterance": 6},
            {"kind": "aside", "first_utterance": 9, "last_utterance": 9, "quote": "wait", "reason": "Aside"}
        ]});
        assert_eq!(validate(&schema(), &v), Ok(()));
        assert_eq!(validate(&schema(), &json!({"suggestions": []})), Ok(()));
    }

    #[test]
    fn rejects_each_kind_of_violation() {
        let s = schema();
        let base = json!({"kind": "retake", "first_utterance": 1, "last_utterance": 1, "quote": "a", "reason": "r"});
        let with = |k: &str, v: Value| {
            let mut o = base.clone();
            o[k] = v;
            json!({ "suggestions": [o] })
        };
        assert!(
            validate(&s, &json!({}))
                .unwrap_err()
                .contains("suggestions")
        );
        assert!(validate(&s, &json!({"suggestions": {}})).is_err());
        assert!(validate(&s, &with("kind", json!("dead_air"))).is_err());
        assert!(validate(&s, &with("first_utterance", json!(0))).is_err());
        assert!(validate(&s, &with("first_utterance", json!("1"))).is_err());
        assert!(validate(&s, &with("last_utterance", json!(1.5))).is_err());
        assert!(validate(&s, &with("quote", json!(""))).is_err());
        assert!(validate(&s, &with("reason", json!("x".repeat(201)))).is_err());
        assert!(
            validate(&s, &with("extra", json!(1)))
                .unwrap_err()
                .contains("extra")
        );
        let mut missing = base.clone();
        missing.as_object_mut().unwrap().remove("quote");
        assert!(
            validate(&s, &json!({"suggestions": [missing]}))
                .unwrap_err()
                .contains("quote")
        );
        assert!(validate(&s, &json!({"suggestions": [], "note": "hi"})).is_err());
    }

    #[test]
    fn unknown_keywords_are_not_ignored() {
        let s = json!({"type": "string", "pattern": "^a"});
        assert!(validate(&s, &json!("a")).unwrap_err().contains("pattern"));
    }
}
