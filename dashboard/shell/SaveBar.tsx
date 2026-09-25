/**
 * Sticky save bar for the settings forms.
 *
 * Rendered on every settings route so the element exists for the whole form
 * lifetime; the `hidden` class (not removal) keeps focus stable.
 */

import {Button} from "@astryxdesign/core/Button";
import {Text} from "@astryxdesign/core/Text";
import {Stack} from "@astryxdesign/core/Stack";
import {useStore} from "../core/store";
import {cx} from "../core/util";

export function SaveBar() {
  const {dirty, save, discard, toast} = useStore();
  return (
    <div id="save-bar" className={cx("save-bar", !dirty && "hidden")}>
      <Text type="supporting">You have unsaved changes.</Text>
      <Stack direction="horizontal" gap={2}>
        <Button
          variant="ghost"
          size="sm"
          type="button"
          data-discard-settings
          label="Discard"
          onClick={() => {
            discard();
            toast("Changes discarded");
          }}
        />
        <Button
          variant="primary"
          size="sm"
          type="button"
          data-save-settings
          label="Save changes"
          onClick={() => void save()}
        />
      </Stack>
    </div>
  );
}
