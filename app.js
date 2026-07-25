const searchInput = document.querySelector('#site-search');
const siteRows = [...document.querySelectorAll('.site-row')];
const addSiteButton = document.querySelector('#add-site');

searchInput.addEventListener('input', (event) => {
  const query = event.target.value.trim().toLowerCase();
  siteRows.forEach((row) => {
    row.hidden = query !== '' && !row.dataset.site.includes(query);
  });
});

addSiteButton.addEventListener('click', () => {
  addSiteButton.textContent = 'Coming soon';
  window.setTimeout(() => { addSiteButton.textContent = '+ Add site'; }, 1400);
});