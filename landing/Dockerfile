FROM nginx:alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY index.html /usr/share/nginx/html/index.html
COPY install.sh /usr/share/nginx/html/install.sh
COPY install.ps1 /usr/share/nginx/html/install.ps1
COPY dashboard.html /usr/share/nginx/html/dashboard.html
COPY app.html /usr/share/nginx/html/app.html
EXPOSE 80
