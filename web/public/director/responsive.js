const navigation = document.querySelector(".director-mobile-navigation");
const buttons = [...navigation.querySelectorAll("button[data-panel]")];

function selectPanel(panel) {
  document.body.dataset.mobilePanel = panel;
  buttons.forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.panel === panel));
  });
}

navigation.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-panel]");
  if (button) selectPanel(button.dataset.panel);
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || event.defaultPrevented || !matchMedia("(max-width: 920px)").matches) return;
  if (document.body.dataset.mobilePanel === "scene") return;
  selectPanel("scene");
  buttons[0].focus();
});
