package limit

import (
	"encoding/json"
	"fmt"
	"reflect"
)

type patchSettings struct {
	Source      string       `json:"settings_source,omitempty"`
	Encoding    string       `json:"encoding,omitempty"`
	ModelLimits []ModelLimit `json:"model_limits"`
	IDs         []int        `json:"ids,omitempty"`
	Limit       int          `json:"limit,omitempty"`
}

func settingsFromState(state PatchState) patchSettings {
	return patchSettings{Encoding: state.Encoding, ModelLimits: state.ModelLimits, IDs: state.IDs, Limit: state.Limit}
}

func validateSettings(settings patchSettings) error {
	if settings.Encoding != "" && settings.Encoding != modelEncoding && settings.Encoding != summaryEncoding {
		return fmt.Errorf("unknown saved settings encoding %q", settings.Encoding)
	}
	minimumID := 0
	if settings.Encoding != "" {
		minimumID = 1
	}
	if err := validateModelLimits(settings.ModelLimits, minimumID); err != nil {
		return err
	}
	if settings.Encoding == "" && !reflect.DeepEqual(settings.ModelLimits, uniformLimits(settings.IDs, settings.Limit)) {
		return fmt.Errorf("saved legacy settings disagree with model limits")
	}
	return nil
}

func settingsFromRecord(record map[string]any) (patchSettings, error) {
	var settings patchSettings
	raw, err := json.Marshal(record)
	if err != nil {
		return settings, err
	}
	if err = json.Unmarshal(raw, &settings); err != nil {
		return settings, fmt.Errorf("invalid saved settings: %w", err)
	}
	if len(settings.ModelLimits) == 0 {
		settings.ModelLimits = uniformLimits(settings.IDs, settings.Limit)
	}
	if err = validateSettings(settings); err != nil {
		return settings, fmt.Errorf("invalid saved settings: %w", err)
	}
	return settings, nil
}

func (s store) requestedSettings(binary string, state PatchState, o options) (patchSettings, string, error) {
	if o.resolveSettings && !o.settingsExplicit {
		if state.Kind == "patched" {
			return settingsFromState(state), "installed", nil
		}
		prepared, err := s.loadPrepare(binary)
		if err != nil {
			return patchSettings{}, "", err
		}
		if prepared != nil {
			values := prepared.ModelLimits
			if len(values) == 0 {
				values = uniformLimits(prepared.IDs, prepared.Limit)
			}
			preparedSettings := patchSettings{Encoding: prepared.Encoding, ModelLimits: values, IDs: prepared.IDs, Limit: prepared.Limit}
			if err := validateSettings(preparedSettings); err != nil {
				return patchSettings{}, "", fmt.Errorf("invalid prepared settings: %w", err)
			}
			return preparedSettings, "prepared", nil
		}
		record, err := s.last(binary)
		if err != nil {
			return patchSettings{}, "", err
		}
		if record != nil && stringField(record, "action") == "patch" {
			settings, err := settingsFromRecord(record)
			return settings, "saved", err
		}
	}
	if o.modelLimits != "" {
		values, err := ParseModelLimits(o.modelLimits)
		return patchSettings{Encoding: modelEncoding, ModelLimits: values}, "explicit", err
	}
	ids, err := ParseIDs(o.ids)
	settings := patchSettings{IDs: ids, Limit: o.limit, ModelLimits: uniformLimits(ids, o.limit)}
	source := "explicit"
	if o.resolveSettings && !o.settingsExplicit {
		source = "defaults"
	}
	return settings, source, err
}

func planSettings(data []byte, settings patchSettings) (Plan, error) {
	if err := validateSettings(settings); err != nil {
		return Plan{}, err
	}
	if settings.Encoding != "" {
		return PlanModelPatch(data, settings.ModelLimits)
	}
	return PlanPatch(data, settings.IDs, settings.Limit)
}

func savedSettingsReport(record map[string]any, state PatchState) (any, string, error) {
	if record == nil {
		if state.Kind == "patched" {
			return nil, "applied-unrecorded", nil
		}
		if state.Kind == "original" {
			return nil, "not-configured", nil
		}
		return nil, "unknown", nil
	}
	action := stringField(record, "action")
	if action != "patch" && action != "restore" {
		return nil, "unknown", nil
	}
	if action == "restore" && record["model_limits"] == nil && record["ids"] == nil {
		return nil, "not-applied", nil
	}
	settings, err := settingsFromRecord(record)
	if err != nil {
		return nil, "unknown", err
	}
	if state.Kind == "original" {
		return settings, "not-applied", nil
	}
	if state.Kind != "patched" {
		return settings, "unknown", nil
	}
	if reflect.DeepEqual(state.ModelLimits, settings.ModelLimits) {
		return settings, "applied", nil
	}
	return settings, "changed", nil
}
