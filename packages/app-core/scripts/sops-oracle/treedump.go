// treedump prints the upstream sops TreeBranches for a YAML or JSON file as
// JSON, with comments and scalar kinds made explicit. Development oracle only.
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"time"

	"github.com/getsops/sops/v3"
	"github.com/getsops/sops/v3/config"
	jsonstore "github.com/getsops/sops/v3/stores/json"
	yamlstore "github.com/getsops/sops/v3/stores/yaml"
)

func conv(v interface{}) interface{} {
	switch v := v.(type) {
	case sops.TreeBranch:
		items := []interface{}{}
		for _, it := range v {
			if c, ok := it.Key.(sops.Comment); ok {
				items = append(items, map[string]interface{}{"comment": c.Value, "inline": c.Inline})
				continue
			}
			items = append(items, map[string]interface{}{"key": it.Key, "value": conv(it.Value)})
		}
		return map[string]interface{}{"map": items}
	case []interface{}:
		items := []interface{}{}
		for _, it := range v {
			if c, ok := it.(sops.Comment); ok {
				items = append(items, map[string]interface{}{"comment": c.Value, "inline": c.Inline})
				continue
			}
			items = append(items, conv(it))
		}
		return map[string]interface{}{"seq": items}
	case string:
		return map[string]interface{}{"str": v}
	case int:
		return map[string]interface{}{"int": strconv.Itoa(v)}
	case int64:
		return map[string]interface{}{"int64": strconv.FormatInt(v, 10)}
	case uint64:
		return map[string]interface{}{"uint64": strconv.FormatUint(v, 10)}
	case float64:
		b, _ := sops.ToBytes(v)
		return map[string]interface{}{"float": string(b)}
	case bool:
		return map[string]interface{}{"bool": v}
	case time.Time:
		b, _ := sops.ToBytes(v)
		return map[string]interface{}{"time": string(b)}
	case []byte:
		return map[string]interface{}{"bytes": string(v)}
	case nil:
		return map[string]interface{}{"null": true}
	default:
		return map[string]interface{}{"unknown": fmt.Sprintf("%T", v)}
	}
}

func main() {
	format := os.Args[1]
	in, err := os.ReadFile(os.Args[2])
	if err != nil {
		panic(err)
	}
	var branches sops.TreeBranches
	if format == "yaml" {
		branches, err = yamlstore.NewStore(&config.YAMLStoreConfig{}).LoadPlainFile(in)
	} else {
		branches, err = jsonstore.NewStore(&config.JSONStoreConfig{Indent: -1}).LoadPlainFile(in)
	}
	if err != nil {
		out, _ := json.Marshal(map[string]string{"error": err.Error()})
		fmt.Println(string(out))
		return
	}
	docs := []interface{}{}
	for _, b := range branches {
		docs = append(docs, conv(b))
	}
	out, _ := json.MarshalIndent(map[string]interface{}{"documents": docs}, "", " ")
	fmt.Println(string(out))
}
